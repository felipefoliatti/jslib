'use strict';

const mysql = require('mysql');

class Logger {
    
    constructor(){
    }

    log(level, message, optional){

        var m = {level: level, timestamp: new Date().toISOString(), message: message};
        if (optional)m.optional = optional;
        

        if(level == Logger.Tipo.ERROR || level == Logger.Tipo.FATAL){
            console.error(m); 
        } else {
            console.info(m); 
        }
    }
}

Logger.Tipo = Object.freeze({"WARN": "WARN", "ERROR":"ERROR", "INFO":"INFO", "FATAL":"FATAL" });    
module.exports.Logger = Logger;
