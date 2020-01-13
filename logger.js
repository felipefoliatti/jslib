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
            console.error("%j", obj);  //for single-line (call stringify before print)
        } else {
            console.info("%j", obj); //for single-line (call stringify before print)
        }
    }
}

Logger.Tipo = Object.freeze({"WARN": "WARN", "ERROR":"ERROR", "INFO":"INFO", "FATAL":"FATAL" });    
module.exports.Logger = Logger;
