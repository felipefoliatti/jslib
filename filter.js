'use strict';

class Filter {
    
    constructor(field, data, op){
        this.field =field;
        this.data = data;
        this.op = op || [{in: "=", out: "="}, {in: "", out: "="}, {in: ">", out: ">"}, {in: "<", out: "<"}, {in: "!", out: "<>"}];
        
        if(!data){
            this.empty = true;
            this.field = "null"
            this.operator = "is"
            this.value = null;
        }
        else{
            let or = this.op.map(m => { return m.in }).join("|");
            let regex = new RegExp(`^([${or}])?(.+)$`);
            let valid = regex.test(data);

            if(!valid) throw Error("invalid filter") 

            let match = regex.exec(data);

            this.empty = false;
            this.operator = this.op.filter(e => e.in == match[1])[0].out;
            this.value = match[2];
        }
    }
    
}

module.exports.Filter = Filter