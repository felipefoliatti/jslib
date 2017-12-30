'use strict';

const mysql = require('mysql');

class Logger {

    static Tipo = Object.freeze({"WARN": "WARN", "ERROR":"ERROR", "INFO":"INFO", "FATAL":"FATAL" })
    
    constructor(){
    }

    log(level, message){
        if(level == Tipo.ERROR || level == Tipo.FATAL){
            console.error(message);
        } else {
            console.info(message);
        }
    }
}

module.exports.Logger = Logger;