const DataComponent = require('../data-component');
const ReactDom = require('react-dom');
const h = require('react-hyperscript');
const EventEmitter = require('eventemitter3');
const io = require('socket.io-client');
const _ = require('lodash');
const Promise = require('bluebird');

const { getId, defer, makeClassList } = require('../../../util');
const Document = require('../../../model/document');

const Notification = require('../notification');
const CornerNotification = require('../notification/corner');

const logger = require('../../logger');
const debug = require('../../debug');

const makeCytoscape = require('./cy');
const defs = require('./defs');
const { EditorButtons, AppButtons } = require('./buttons');
const UndoRemove = require('./undo-remove');
const Help = require('./help');
const { TaskList } = require('./task-list');

const RM_DEBOUNCE_TIME = 500;
const RM_AVAIL_DURATION = 5000;

class Editor extends DataComponent {
  constructor( props ){
    super( props );

    let docSocket = io.connect('/document');
    let eleSocket = io.connect('/element');

    let logSocketErr = (err) => logger.error('An error occurred during clientside socket communication', err);

    docSocket.on('error', logSocketErr);
    eleSocket.on('error', logSocketErr);

    let id = _.get( props, 'id' );
    let secret = _.get( props, 'secret' );

    let doc = new Document({
      socket: docSocket,
      factoryOptions: { socket: eleSocket },
      data: { id, secret }
    });

    if( debug.enabled() ){
      window.doc = doc;
      window.editor = this;
    }

    let checkToClearRmList = () => {
      let now = Date.now();
      let l = this.data.rmList;

      if( now - l.lastTime > RM_DEBOUNCE_TIME ){
        l.els = [];
        l.ppts = [];
      }

      l.lastTime = now;
    };

    let rmAvailTimeout = null;

    let makeRmAvailable = () => {
      clearTimeout( rmAvailTimeout );

      rmAvailTimeout = setTimeout( () => {
        this.setData({ undoRemoveAvailable: false });
      }, RM_AVAIL_DURATION );

      this.setData({ undoRemoveAvailable: true });
    };

    let addRmPptToList = (intn, ppt, type) => {
      checkToClearRmList();
      makeRmAvailable();

      this.data.rmList.ppts.push({ intn, ppt, type });
    };

    let addRmToList = el => {
      checkToClearRmList();
      makeRmAvailable();

      this.data.rmList.els.push( el );
    };

    let listenForRmPpt = intn => intn.on('remove', (el, type) => addRmPptToList(intn, el, type));

    doc.on('remove', el => {
      addRmToList( el );

      el.removeAllListeners(); // just to make sure that we don't have dangling listeners causing issues
    });

    doc.on('add', el => {
      if( el.isInteraction() ){
        listenForRmPpt( el );
      }
    });

    doc.on('load', () => {
      doc.interactions().forEach( listenForRmPpt );

      let docs = JSON.parse(localStorage.getItem('my-factoids')) || [];
      let docData = { id: doc.id(), secret: doc.secret(), name: doc.name() };

      if( _.find(docs,  docData) == null ){
        docs.push(docData);
        localStorage.setItem('my-factoids', JSON.stringify(docs));
      }
    });

    let bus = new EventEmitter();

    bus.on('drawtoggle', toggle => this.toggleDrawMode(toggle));
    bus.on('addelement', data => this.addElement( data ));
    bus.on('remove', docEl => this.remove( docEl ));

    this.data = ({
      bus: bus,
      document: doc,
      drawMode: false,
      taskListMode: false,
      newElementShift: 0,
      mountDeferred: defer(),
      initted: false,
      rmList: {
        els: [],
        ppts: [],
        lastTime: 0
      }
    });

    logger.info('Checking if doc with id %s already exists', doc.id());

    Promise.try( () => doc.load() )
      .then( () => logger.info('The doc already exists and is now loaded') )
      .catch( err => {
        logger.info('The doc does not exist or an error occurred');
        logger.warn( err );

        return ( doc.create()
          .then( () => logger.info('The doc was created') )
          .catch( err => logger.error('The doc could not be created', err) )
        );
      } )
      .then( () => doc.synch(true) )
      .then( () => logger.info('Document synch active') )
      .then( () => {
        this.setData({ initted: true });

        logger.info('The editor is initialising');
      } )
      .then( () => this.data.mountDeferred.promise )
      .then( () => {
        let graphCtr = ReactDom.findDOMNode(this).querySelector('#editor-graph');

        this.data.cy = makeCytoscape({
          container: graphCtr,
          document: this.data.document,
          bus: this.data.bus,
          controller: this
        });

        logger.info('Initialised Cytoscape on mounted editor');
      } )
      .then( () => {
        let anyIsInc = doc.entities().some( ent => !ent.completed() );

        let ntfn = new Notification({
          openable: true,
          openText: 'Show me',
          active: anyIsInc,
          message: 'Provide more information for incomplete entities, labelled "?".'
        });

        ntfn.on('open', () => this.openFirstIncompleteEntity());

        if( this.editable() ){
          let listenForComplete = el => el.on('complete', () => ntfn.dismiss());

          doc.elements().forEach(listenForComplete);
          doc.on('add', listenForComplete);

          this.setData({ incompleteNotification: ntfn });
        }
      } )
      .then( () => {
        logger.info('The editor has initialised');
      } )
      .catch( (err) => logger.error('An error occurred livening the doc', err) )
    ;
  }

  editable(){
    return this.data.document.editable();
  }

  toggleDrawMode( toggle ){
    if( !this.editable() ){ return; }

    let on = toggle === undefined ? !this.drawMode() : toggle;

    this.data.bus.emit( on ? 'drawon' : 'drawoff' );

    return new Promise( resolve => this.setData({ drawMode: on }, resolve) );
  }

  drawMode(){
    return this.data.drawMode;
  }

  toggleTaskListMode( toggle ){
    if( !this.editable() ){ return; }

    let on = toggle === undefined ? !this.taskListMode() : toggle;

    this.data.bus.emit( on ? 'taskliston' : 'tasklistoff' );

    return new Promise( resolve => this.setData({ taskListMode: on }, resolve) );
  }

  taskListMode(){
    return this.data.taskListMode;
  }

  addElement( data = {} ){
    if( !this.editable() ){ return; }

    let cy = this.data.cy;
    let pan = cy.pan();
    let zoom = cy.zoom();
    let getPosition = rpos => ({
      x: ( rpos.x - pan.x ) / zoom,
      y: ( rpos.y - pan.y ) / zoom
    });
    let shift = ( pos, delta ) => ({ x: pos.x + delta.x, y: pos.y + delta.y });
    let shiftSize = defs.newElementShift;
    let shiftI = this.data.newElementShift;
    let delta = { x: 0, y: shiftSize * shiftI };
    let pos = getPosition( shift( _.clone( defs.newElementPosition ), delta ) );

    this.setData({ newElementShift: (shiftI + 1) % defs.newElementMaxShifts });

    let doc = this.data.document;

    let el = doc.factory().make({
      data: _.assign( {
        type: 'entity',
        name: '',
        position: pos
      }, data )
    });

    this.lastAddedElement = el;

    let synch = () => el.synch();
    let create = () => el.create();
    let add = () => doc.add( el );

    return Promise.try( synch ).then( create ).then( add ).then( () => el );
  }

  getLastAddedElement(){
    return this.lastAddedElement;
  }

  addInteraction( data = {} ){
    if( !this.editable() ){ return; }

    return this.addElement( _.assign({
      type: 'interaction',
      name: ''
    }, data) );
  }

  remove( docElOrId ){
    if( !this.editable() ){ return; }

    let doc = this.data.document;
    let docEl = doc.get( getId( docElOrId ) ); // in case id passed
    let rmPpt = intn => intn.has( docEl ) ? intn.remove( docEl ) : Promise.resolve();
    let allIntnsRmPpt = () => Promise.all( doc.interactions().map( rmPpt ) );
    let rmEl = () => doc.remove( docEl );

    Promise.try( allIntnsRmPpt ).then( rmEl );
  }

  undoRemove(){
    let { rmList, document } = this.data;

    if( rmList.els.length === 0 && rmList.ppts.length === 0 ){ return Promise.resolve(); }

    this.setData({
      rmList: { els: [], ppts: [], lastTime: 0 }
    });

    let makeRmUnavil = () => this.setData({ undoRemoveAvailable: false });

    let restoreEls = () => Promise.all( rmList.els.map( el => document.add(el) ) );

    let restorePpts = () => Promise.all( rmList.ppts.map( ({ intn, ppt, type }) => {
      let restorePpt = () => intn.add( ppt );
      let restoreType = () => intn.participantType( ppt, type );

      return Promise.try( restorePpt ).then( restoreType );
    } ) );

    return Promise.all([ restoreEls(), restorePpts() ]).then( makeRmUnavil );
  }

  layout(){
    if( !this.editable() ){ return; }

    this.data.bus.emit('layout');
  }

  fit(){
    this.data.bus.emit('fit');
  }

  removeSelected(){
    if( !this.editable() ){ return; }

    this.data.bus.emit('removeselected');
  }

  openFirstIncompleteEntity(){
    if (!this.editable()) { return; }

    let { document, bus } = this.data;

    let incEnts = document.entities().filter(ent => !ent.completed());

    if( incEnts.length > 0 ){
      bus.emit('opentip', incEnts[0]);
    }
  }

  resetMenuState(){
    this.data.bus.emit('closetip');
    this.data.bus.emit('hidetips');
    return Promise.all([this.toggleTaskListMode(false),  this.toggleDrawMode(false)]).delay(250);
  }

  render(){
    let { document, bus, incompleteNotification } = this.data;
    let controller = this;
    let { history } = this.props;

    let showTaskList = this.data.taskListMode;

    let editorContent = this.data.initted ? [
      h('div.editor-branding', [
        h('div.editor-title', document.name() === '' ? 'Untitled document' : document.name())
      ]),
      h(EditorButtons, { className: 'editor-buttons', controller, document, bus, history }),
      h(AppButtons, { className: showTaskList ? 'editor-buttons-right.editor-buttons-right-shifted' : 'editor-buttons-right', controller, document, bus, history } ),
      incompleteNotification ? h(CornerNotification, { notification: incompleteNotification }) : h('span'),
      h(UndoRemove, { controller, document, bus }),
      h(`div.${showTaskList ? 'editor-graph-shifted#editor-graph' : 'editor-graph#editor-graph'}`),
      h(Help, { document, bus, controller }),
      h(TaskList, { document, bus, controller, show: showTaskList })
    ] : [];

    return h('div.editor', {
      className: makeClassList({
        'editor-initted': this.data.initted,
        'editor-task-list-active': this.taskListMode()
      })
    }, editorContent);
  }

  componentDidMount(){
    this.data.mountDeferred.resolve();
  }

  componentWillUnmount(){
    let { cy, document, bus } = this.data;

    bus.emit('destroytip');

    if( cy ){
      cy.destroy();
    }

    document.elements().forEach( el => el.removeAllListeners() );
    document.removeAllListeners();
    bus.removeAllListeners();
  }
}

module.exports = Editor;
