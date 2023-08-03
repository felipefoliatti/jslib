'use strict';

/**
 * Filter class
 * The example above demonstrates how to use the filter.
 * 
 * @example
 * var status = new filter.Filter('status', req.query.username, [{in: "", out: "="}])
 * @description
 * The variable status now has trhe properties: field, operator and value. Theese propertis can now be used to mount any query statement 
 * 
 * @class Filter
 */
class Filter {

    static OP = {
      STRING: {
        EQ:  (opt) => Filter.assign({in: "", out: "=", fn: (e)=> e.replace(/\s/g,''), placeholder: '?' },               opt, {custom: false}),
        IN:  (opt) => Filter.assign({in: "", out: "in", fn: (e)=> e.replace(/\s/g,'').split(','), placeholder: '(?)' }, opt, {custom: false}),
        LK:  (opt) => Filter.assign({in: "", out: "like", fn: (e)=> e.enclose("%"), placeholder: '?' },                 opt, {custom: false}),        
        NEQ: (opt) => Filter.assign({in: "", out: "<>", fn: (e)=> e.replace(/\s/g,''), placeholder: '?'},               opt, {custom: false}),
      },
      BOOL: {
        IN:  (opt) => Filter.assign({in: "", out: "in", fn: (e)=> e.replace(/\s/g,'').split(','), placeholder: '(?)' }, opt, {custom: false}),
        EQ:  (opt) => Filter.assign({in: "", out: "=", fn: (e)=> e.replace(/\s/g,''), placeholder: '?' },               opt, {custom: false}),        
        NEQ: (opt) => Filter.assign({in: "", out: "<>", fn: (e)=> e.replace(/\s/g,''), placeholder: '?'},               opt, {custom: false}),
      },
      INT: {
        EQ:  (opt) => Filter.assign({in: "", out: "=", fn: (e)=> e.replace(/\s/g,''), placeholder: '?' },               opt, {custom: false}),
        IN:  (opt) => Filter.assign({in: "", out: "in", fn: (e)=> e.replace(/\s/g,'').split(','), placeholder: '(?)' }, opt, {custom: false}),
        GT:  (opt) => Filter.assign({in: "", out: ">=", fn: (e)=> e.replace(/\s/g,''), placeholder: '?' },              opt, {custom: false}),
        LT:  (opt) => Filter.assign({in: "", out: "<=", fn: (e)=> e.replace(/\s/g,''), placeholder: '?' },              opt, {custom: false}),
        NEQ: (opt) => Filter.assign({in: "", out: "<>", fn: null, placeholder: '?'}, opt),
      },
      CUSTOM: (opt) => Filter.assign({in: "", query: (value)=>"", fn: (e)=> e.replace(/\s/g,'') }, opt, {custom: true})
    }
  
    static assign(...objects){
      return objects.reduce((p, c) => Object.assign(p, c), {})
    }
  
    constructor(field, value, ...op){
  
      this.field = field;
      this.op = op.map(e => (typeof e === 'function')? e():e); //convert function to value
  
      this.operation = '';
      this.value = [];
      
  
      if (!Array.isArray(value)){
        value = [value];
      }
  
      let contexts = [];
      for(let i=0; i < value.length; i ++){
        
        let context = { field: this.field, value: value[i] };
  
        if(!context.value){
            context.empty = true;
            context.field = "null"
            context.operator = "is"
            context.operation = `(${context.field} ${context.operator} NULL)`;
            context.value = [];
        }else{
            let or = this.op.map(m => { return m.in }).join("|");
            let regex = new RegExp(`^([${or}])?(.+)$`);
            let valid = regex.test(context.value);
  
            if(!valid) throw Error("invalid filter");
  
            let match = regex.exec(context.value);
            let operators = this.op.filter(e => context.value.startsWith(e.in) || e.in == "").reverse(); //the first find is the last item
            
            if (!operators.length) throw Error(`operator '${match[1]}' not found`);
            let operator = operators[0];
  
            if (!operator.custom){
              let value = operator.fn? operator.fn(match[2]) : match[2];
              context.empty = false;
              context.operator = operator.out;
              context.value = [value];
              context.operation = `(${context.field} ${operator.out} ${operator.placeholder})`;
            } else {
              let value = operator.fn? operator.fn(match[2]) : match[2]; 
              let query = operator.query(value)
  
              context.empty = false;
              context.operator = null;
              context.value = (query.match(/\?/g)||[]).map(() => value); //repeat the value as many as we have ?
              context.operation = `(${query.replace(/\:field/g, this.field)})`;
            }
        }
  
        contexts.push(context);
      }
  
      this.operation = `(${contexts.map(e => e.operation).join(' AND ')})`;
      this.value = contexts.map(e => e.value).flat();
      
  }
}  

module.exports.Filter = Filter