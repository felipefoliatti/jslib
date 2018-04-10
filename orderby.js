'use strict';

class Orderby {

    //config
    //  single: true/false
    constructor(config){
        this.config = config;
    }
    
    parse (param) {
        let valid = this.config.single? new RegExp(/^(([-+]\w+)|(\w+))*$/).test(param):new RegExp(/^(([-+]\w+)|(\w+))(,(([-+]\w+)|(\w+)))*$/).test(param);
        if(!valid) throw Error("invalid order") 

        let orders = param.split(',').map((field) =>{
            let order = "";
            if(field && field[0] == '-'){
                order += " desc";
                field = field.substring(1);
            }
            if(field && field[0] == '+'){
                order += " asc";
                field = field.substring(1);
            } 
              
            if(field){
                order = field + order;
            }
            return order;
        }).join(",");
        return orders; 
    }

}

module.exports.Orderby = Orderby