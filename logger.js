'use strict';

const mysql = require('mysql');

class Logger {
    
    constructor(){
    }

    log(level, message){
        if(level == Logger.Tipo.ERROR || level == Logger.Tipo.FATAL){
            console.error({level: level, timestamp: new Date().toISOString(), message: message}); 
        } else {
            console.info({level: level, timestamp: new Date().toISOString(), message: message}); 
        }
    }
}

Logger.Tipo = Object.freeze({"WARN": "WARN", "ERROR":"ERROR", "INFO":"INFO", "FATAL":"FATAL" });    
module.exports.Logger = Logger;
