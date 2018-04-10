'use strict';

class Filter {
    
    constructor(field, data){
        this.field =field;
        this.data = data;
        
        if(!data){
            this.empty = true;
            this.field = "null"
            this.operator = "is"
            this.value = null;
        }
        else{

            let regex = new RegExp(/^([><])?(.+)$/);
            let valid = regex.test(data);

            if(!valid) throw Error("invalid filter") 

            let match = regex.exec(data);

            this.empty = false;
            this.operator = match[1] || "=";
            this.value = match[2];
        }
    }
    
}

module.exports.Filter = Filter