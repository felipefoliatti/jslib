'use strict';

class Fields {
    
    constructor(fields){
        this.fields = fields;
    }
    
    parse (params) {
        let me = this;
        let itens = (params || '').split(',').filter((field) => { return me.fields.indexOf(field) > -1; }).join(",");
        return itens; 
    }

}

module.exports.Fields = Fields