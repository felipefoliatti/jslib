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
    
    /**
     * @description
     * Creates a new instance of a {@link Filter}. It has no methods, but has the fields above:
     * 
     * @property {String}  this.field the fieldname.
     * @property {String}  this.operator  the operator, that is calculated based on 'out'. If the field is null, operator will be IS. Otherwise will be what is specified in 'out'
     * @property {String}  this.operation  the operatoration is based on 'out' and 'placeholder'. If the field is null, operation will be 'out' + ?. Otherwise will be 'out' + '(?)'.
     * @property {Object}  this.value the filter value.
     * 
     * @description
     * To generate the constructor, use the following parameters.
     * 
     * @param {String} field  the fieldname to be stored at {@link Filter#field}.
     * @param {String} data the value of the filter to be evaluated in operations passed by the param op.
     * @param {Object[]} op the array of operations to eval against the param data.
     * @param {String} op[].in - the string searched in the parameter.
     * @param {String} op[].out the string returned in the {@link Filter#operator}.
     * @param {Function} op[].fn the action used parse the value in {@link Filter#value}. It can be null.
     * @param {Object} config the config defines how the Filter will act
     * @param {Function} config.placeholder function that receives the value (after fn) as argument and returns the placeholder
     * @param {Function} config.placeholderEmpty function that receives the value (after fn) as argument and returns the placeholder when the data is empty 
     * 
     */
    constructor(field, data, op, config){
        this.field =field;
        this.data = data;
        this.op = op || [{in: "=", out: "=", fn: null}, {in: "", out: "=", fn: null}, {in: ">", out: ">", fn: null}, {in: "<", out: "<", fn: null}, {in: "!", out: "<>", fn: null}];
        this.config = config || {}

        if(!data){
            this.empty = true;
            this.field = "null"
            this.operator = "is"
            this.operation = "is" + (this.config.placeholderEmpty? this.config.placeholderEmpty(this.data) : "(?) ")
            this.value = null;
        }
        else{
            let or = this.op.map(m => { return m.in }).join("|");
            let regex = new RegExp(`^([${or}])?(.+)$`);
            let valid = regex.test(data);

            if(!valid) throw Error("invalid filter") 

            let match = regex.exec(data);
            let operators = this.op.filter(e => e.in == (match[1] || "") );

            if (!operators.length) throw Error(`operator '${match[1]}' not found`);

            this.empty = false;
            this.operator = operators[0].out;
            this.value = operators[0].fn? operators[0].fn(match[2]) : match[2];
            this.operation = operators[0].out + (this.config.placeholderEmpty? this.config.placeholderEmpty(this.value) : " (?)")
        }
    }
    
}

module.exports.Filter = Filter