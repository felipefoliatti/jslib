'use strict';

class Orderby {

    //config
    //  single: true/false
    //  allowed: [] fields allowed 
    constructor(config){
        this.config = config;
    }
    
    parse (param) {
        var valid = this.config.single? new RegExp(/^(([-+]\w+)|(\w+))*$/).test(param):new RegExp(/^(([-+]\w+)|(\w+))(,(([-+]\w+)|(\w+)))*$/).test(param);
        var unallowed = [];
        var me = this;

        if(!valid) throw Error("invalid order");


        var orders = param.split(',').map((field) =>{
            var order = "";
            if(field && field[0] == '-'){
                order += " desc";
                field = field.substring(1);
            }
            if(field && field[0] == '+'){
                order += " asc";
                field = field.substring(1);
            } 
            
            //If exist some allowed field, consider it
            if (me.config.allowed && me.config.allowed.indexOf(field) == -1){
                unallowed.push(field);
            }
            
            if(field){
                order = field + order;
            }
            return order;
        }).join(",");

        //If there is some unallowed field
        if(unallowed && unallowed.length){
            throw Error("invalid field: " + unallowed.join(",")); 
        }

        return orders; 
    }

}

module.exports.Orderby = Orderby