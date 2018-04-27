'use strict';

class Logger {
    
    constructor(){
    }

    _isObject(a) {
        return (!!a) && (a.constructor === Object);
    };

    log(obj){

        obj.timestamp = new Date().toISOString();                

        if(obj.level == Logger.Tipo.ERROR || obj.level == Logger.Tipo.FATAL){
            console.error(obj); 
        } else {
            console.info(obj); 
        }
    }
}

Logger.Tipo = Object.freeze({"WARN": "WARN", "ERROR":"ERROR", "INFO":"INFO", "FATAL":"FATAL" });    
module.exports.Logger = Logger;
