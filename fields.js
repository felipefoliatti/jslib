'use strict';

class Fields {
    
    /**
     * 
     * @param {Array[Object]} fields - array of field objects, that is a mapping object
     * @param {String} fields[].key - the map key that will be searched
     * @param {String} fields[].value - the map value that will be returned if the key is found
     * 
     */
    constructor(fields){
        this.fields = fields;
    }
    
    /**
     * 
     * @param {String} params - fields separeted by comma
     */
    parse (params) {
        let me = this;
        let itens = (params || '').split(',');
        
        let result = me.fields
                       .filter((field) => { 
                            return itens.filter(it => { return it.trim() == field.key }).length > 0 
                        })
                        .map(field => field.value )
                        .join(",") //join all strings, some substrings can also be comma-separeted strings
                        .split(",") //split to remove all empty spaces between fields
                        .map(f => f.trim()); 

        let unique = result.filter(function(item, pos) {
            return result.indexOf(item) == pos;
        })

        return unique.join(","); 
    }

}

module.exports.Fields = Fields