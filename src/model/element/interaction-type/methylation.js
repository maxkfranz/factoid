const Modification = require('./modification');

const VALUE = 'methylation';
const DISPLAY_VALUE = 'Methylation';
const EFFECT = 'methylated';

class Methylation extends Modification {
  constructor( intn ){
    super( intn );
  }

  toBiopaxTemplate(){
    return super.toBiopaxTemplate(EFFECT);
  }

  toString(){
    return super.toString(VALUE);
  }

  static get value(){ return VALUE; }
  get value(){ return VALUE; }

  static get displayValue(){ return DISPLAY_VALUE; }
  get displayValue(){ return DISPLAY_VALUE; }
}

module.exports = Methylation;
