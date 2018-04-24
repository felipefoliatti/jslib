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
            let operators = this.op.filter(e => e.in == (match[1] || "") );

            if (!operators) throw Error(`operator '${match[1]}' not found`);

            this.empty = false;
            this.operator = operators[0].out;
            this.value = match[2];
        }
    }
    
}

module.exports.Filter = Filter