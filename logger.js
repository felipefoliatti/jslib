'use strict';

const mysql = require('mysql');

class Logger {

    static Tipo = Object.freeze({"WARN": "WARN", "ERROR":"ERROR", "INFO":"INFO", "FATAL":"FATAL" })
    
    constructor(){
    }

    log(level, message){
        if(level == Tipo.ERROR || level == Tipo.FATAL){
            console.error({message: message, timestamp: new Date().toISOString(), level: level}); 
        } else {
            console.info({message: message, timestamp: new Date().toISOString(), level: level}); 
        }
    }
}

module.exports.Logger = Logger;