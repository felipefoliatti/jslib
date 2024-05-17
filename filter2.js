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
        EQ:  (opt) => Filter.assign({in: "", out: "=",   fn: (e)=> ({data: e.toString().replace(/\s/g,''),            expand: false}), placeholder: '?' },   opt, {custom: false}),
        IN:  (opt) => Filter.assign({in: "", out: "in",  fn: (e)=> ({data: e.toString().replace(/\s/g,'').split(','), expand: false}), placeholder: '(?)' }, opt, {custom: false}),
        LK:  (opt) => Filter.assign({in: "", out: "like",fn: (e)=> ({data: e.toString().enclose("%"),                 expand: false}), placeholder: '?' },   opt, {custom: false}),        
        LKE: (opt) => Filter.assign({in: "", out: "like",fn: (e)=> ({data: e.toString().concat("%"),                  expand: false}), placeholder: '?' },   opt, {custom: false}),        
        NEQ: (opt) => Filter.assign({in: "", out: "<>",  fn: (e)=> ({data: e.toString().replace(/\s/g,''),            expand: false}), placeholder: '?'},    opt, {custom: false}),
      },
      BOOL: {
        IN:  (opt) => Filter.assign({in: "", out: "in", fn: (e)=> ({data: e.toString().replace(/\s/g,'').split(','), expand: false}), placeholder: '(?)' }, opt, {custom: false}),
        EQ:  (opt) => Filter.assign({in: "", out: "=",  fn: (e)=> ({data: e.toString().replace(/\s/g,''),            expand: false}), placeholder: '?'   }, opt, {custom: false}),        
        NEQ: (opt) => Filter.assign({in: "", out: "<>", fn: (e)=> ({data: e.toString().replace(/\s/g,''),            expand: false}), placeholder: '?'   }, opt, {custom: false}),
      },
      INT: {
        EQ:  (opt) => Filter.assign({in: "", out: "=",  fn: (e)=> ({data: parseInt(e.toString().replace(/\s/g,'')),                        expand: false}), placeholder: '?'   }, opt, {custom: false}),
        IN:  (opt) => Filter.assign({in: "", out: "in", fn: (e)=> ({data: e.toString().replace(/\s/g,'').split(',').map(e => parseInt(e)), expand: false}), placeholder: '(?)' }, opt, {custom: false}),
        GT:  (opt) => Filter.assign({in: "", out: ">",  fn: (e)=> ({data: parseInt(e.toString().replace(/\s/g,'')),                        expand: false}), placeholder: '?'   }, opt, {custom: false}),
        GTE: (opt) => Filter.assign({in: "", out: ">=", fn: (e)=> ({data: parseInt(e.toString().replace(/\s/g,'')),                        expand: false}), placeholder: '?'   }, opt, {custom: false}),
        LT:  (opt) => Filter.assign({in: "", out: "<",  fn: (e)=> ({data: parseInt(e.toString().replace(/\s/g,'')),                        expand: false}), placeholder: '?'   }, opt, {custom: false}),
        LTE: (opt) => Filter.assign({in: "", out: "<=", fn: (e)=> ({data: parseInt(e.toString().replace(/\s/g,'')),                        expand: false}), placeholder: '?'   }, opt, {custom: false}),
        NEQ: (opt) => Filter.assign({in: "", out: "<>", fn: (e)=> ({data: parseInt(e.toString().replace(/\s/g,'')),                        expand: false}), placeholder: '?'   }, opt),
      },
      DATETIME: {
        EQ:  (opt) => Filter.assign({in: "", out: "=",                                                                                                 fn: (e)=> ({data: e.toString().replace(/\s/g,''), expand: false}), placeholder: '?' },           opt, {custom: false}),
        GT:  (opt) => Filter.assign({in: "", out: ">",                                                                                                 fn: (e)=> ({data: e.toString().replace(/\s/g,''), expand: false}), placeholder: '?' },           opt, {custom: false}),
        GTE: (opt) => Filter.assign({in: "", out: ">=",                                                                                                fn: (e)=> ({data: e.toString().replace(/\s/g,''), expand: false}), placeholder: '?' },           opt, {custom: false}),
        LT:  (opt) => Filter.assign({in: "", out: "<",                                                                                                 fn: (e)=> ({data: e.toString().replace(/\s/g,''), expand: false}), placeholder: '?' },           opt, {custom: false}),
        LTE: (opt) => Filter.assign({in: "", out: "<=",                                                                                                fn: (e)=> ({data: e.toString().replace(/\s/g,''), expand: false}), placeholder: '?' },           opt, {custom: false}),
        BTW: (opt) => Filter.assign({in: "", lop: ">=", rop: "<=", query: {fn: (value, operator)=> `:field ${operator.lop} ? AND :field ${operator.rop} ?`, expand: false, join: 'AND'}, fn: (e)=> ({data: Filter.require(e.toString().replace(/\s/g,'').split(','),2), expand: true}) }, opt, {custom: true}),
      },
      DATE: {
        EQ:  (opt) => Filter.assign({in: "", out: "=",  field: 'DATE(:field)',                                                                                                                       fn: (e)=> ({data: e.toString().replace(/\s/g,''), expand: false}), placeholder: 'DATE(?)' },           opt, {custom: false}),
        GT:  (opt) => Filter.assign({in: "", out: ">",  field: 'DATE(:field)',                                                                                                                       fn: (e)=> ({data: e.toString().replace(/\s/g,''), expand: false}), placeholder: 'DATE(?)' },           opt, {custom: false}),
        GTE: (opt) => Filter.assign({in: "", out: ">=", field: 'DATE(:field)',                                                                                                                       fn: (e)=> ({data: e.toString().replace(/\s/g,''), expand: false}), placeholder: 'DATE(?)' },           opt, {custom: false}),
        LT:  (opt) => Filter.assign({in: "", out: "<",  field: 'DATE(:field)',                                                                                                                       fn: (e)=> ({data: e.toString().replace(/\s/g,''), expand: false}), placeholder: 'DATE(?)' },           opt, {custom: false}),
        LTE: (opt) => Filter.assign({in: "", out: "<=", field: 'DATE(:field)',                                                                                                                       fn: (e)=> ({data: e.toString().replace(/\s/g,''), expand: false}), placeholder: 'DATE(?)' },           opt, {custom: false}),
        BTW: (opt) => Filter.assign({in: "", lop: ">=", rop: "<=", query: {fn: (value, operator)=> `DATE(:field) ${operator.lop} DATE(?) AND DATE(:field) ${operator.rop} DATE(?)`, expand: false, join: 'AND'}, fn: (e)=> ({data: Filter.require(e.toString().replace(/\s/g,'').split(','),2), expand: true}) }, opt, {custom: true}),
      },
      CUSTOM: (opt) => Filter.assign({in: "", query: {fn: ()=>"", expand: false, join: 'AND'}, fn: (e)=>  ({data: e.toString().replace(/\s/g,''), expand: false}) }, opt, {custom: true})
    }
  
    static assign(...objects){
      return objects.reduce((p, c) => Object.assign(p, c), {})
    }

    static require(array, count){
      if (!array || array.length != count){ throw new Error('invalid filter, requiring two arguments: ' + array) }
      return array;
    }
  
    constructor(field, value, ...op){
  
      this.field = field;
      this.op = op.map(e => (typeof e === 'function')? e():e); //convert function to value
  
      this.operation = '';
      this.value = [];

      let getPlaceholders = (query) => (query.match(/\?/g)||[]);
      
      //make the value always an array
      if (!Array.isArray(value)){
        value = [value]
      }
       
      let contexts = [];
      for(let i=0; i < value.length; i ++){
        
        let context = { value: value[i] };
        if(context.value === null || context.value === undefined || context.value === '' || (Array.isArray(context.value) && !context.value.length)){
            context.empty = true;
            context.field = "null"
            context.operator = "is"
            context.operation = `(${context.field} ${context.operator} NULL)`;
            context.value = [{data: undefined, expand: false}];
        }else{
           
            let operators = this.op.filter(e => context.value.toString().startsWith(e.in) || e.in == "").reverse(); //the first find is the last item            

            if (!operators.length) throw Error(`operator in '${context.value}' not found`);
            let operator = operators[0];    
            
            //clear the data removing the prefix
            context.value = context.value.toString().slice(operator.in.length);

            if (!operator.custom){
              let value = operator.fn? operator.fn(context.value) : {data: context.value, expand: false};
              
              context.field = operator.field? operator.field.replace(/\:field/g, this.field) : this.field;
              context.empty = false;
              context.operator = operator.out;
              context.value = [value];
              context.operation = `(${context.field} ${operator.out} ${operator.placeholder})`;
            } else {
              let value = operator.fn? operator.fn(context.value) : {data: context.value, expand: false}; 
              
              let query = operator.query.fn(value.data, operator).replace(/\:field/g, this.field);
              let queries = operator.query.expand? value.data.map(() => query) : [query]; //query.expand means that we and to replicate the query as many items we have in the data array.
              
              context.field = this.field;
              context.empty = false;
              context.operator = null;
              context.value = value.expand? [value] : queries.map(query => getPlaceholders(query).map(() => value)).flat(); //value.exapnd means the params is an array and will be added item by item, expecting to have ? as many items we have in the data array. If we don't need to expand it, we have to fill the ? with the array
              context.operation = `(${queries.join(` ${operator.query.join} `)})`;
            }
        }
  
        contexts.push(context);
      }
  
      if (!contexts.length) contexts.push({operation: '(NULL IS NULL)', value: [], expand: false});

      this.operation = `(${contexts.map(e => e.operation).join(' AND ')})`;
      this.value = []
      
      contexts.forEach(context => {
        //iterate over value: it is always an array
        context.value.forEach(value => {
          if (Array.isArray(value.data)){
            if (value.expand){
              this.value.push(...value.data)
            }else {
              this.value.push(value.data)
            }
          } else if (value.data !== undefined) {
            //undefined should not be add
            this.value.push(value.data)
          } 
        });    
      });      
      
  }
}  

module.exports.Filter = Filter