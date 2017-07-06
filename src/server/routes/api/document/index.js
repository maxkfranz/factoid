const Document = require('../../../../model/document');
const db = require('../../../db');
const Promise = require('bluebird');
const _ = require('lodash');
const provider = require('./null');
const uuid = require('uuid');

let newDoc = ({ docDb, eleDb, id, secret }) => {
  return new Document( _.assign( {}, docDb, {
    factoryOptions: eleDb,
    data: _.defaults( {}, { id, secret } )
  } ) );
};

let loadDoc = ({ docDb, eleDb, id }) => {
  let doc = newDoc({ docDb, eleDb, id });

  return doc.load().then( () => doc );
};

let createDoc = ({ docDb, eleDb, secret }) => {
  let doc = newDoc({ docDb, eleDb, secret });

  return doc.create().then( () => doc );
};

let tables = ['document', 'element'];

let loadTable = name => db.accessTable( name );

let loadTables = () => Promise.all( tables.map( loadTable ) ).then( dbInfos => ({
  docDb: dbInfos[0],
  eleDb: dbInfos[1]
}) );

let getDocJson = doc => doc.json();

let fillDoc = ( doc, text ) => {
  return provider.get( text ).then( res => {
    return doc.fromJson( res );
  } ).then( () => doc );
};

module.exports = function( http ){
  // get existing doc
  http.get('/document/:id', function( req, res ){
    let id = req.params.id;

    ( Promise.try( loadTables )
      .then( json => _.assign( {}, json, { id } ) )
      .then( loadDoc )
      .then( getDocJson )
      .then( json => res.json( json ) )
    );
  });

  // create new doc
  http.post('/document', function( req, res ){
    let text = req.body.text;
    let secret = uuid();

    ( Promise.try( loadTables )
      .then( ({ docDb, eleDb }) => createDoc({ docDb, eleDb, secret }) )
      .then( doc => fillDoc( doc, text ) )
      .then( getDocJson )
      .then( json => res.json( json ) )
    );
  });
};
