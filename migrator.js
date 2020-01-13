'use strict';

const mysql = require('mysql');
const marv = require('marv/api/promise'); 
const driver = require('marv-mysql-driver');

class Migrator {

     constructor(config){
        this.drivername = config.drivername;
        this.database = config.database;
        this.user= config.user;
        this.password = config.password;
        this.host= config.host;
        this.port = config.port;
        this.multiple = config.multiple;
        this.connectionLimit = config.connectionLimit;
        this.path = config.path;
    }

    migrate(){
        var me = this;
        var p = new Promise((resolve, reject)=>{
            
            try{
                
                var conn = mysql.createConnection({user: me.user, password: me.password, host: me.host, port: me.port});

                conn.connect();
                conn.query(`CREATE DATABASE IF NOT EXISTS \`${me.database}\``, async (err, result, field) => {
                    if (err) reject(err);
                    
                    try {
                        var migrations = await marv.scan(me.path);
                        var connection = {user: me.user, password: me.password, host: me.host, port: me.port, database: me.database, multipleStatements: true};
                    
                        await marv.migrate(migrations, driver({connection}));

                        conn.end();
                        conn.destroy();
                        resolve();
    
                    } catch(err){
                        reject(err);
                    }
                });
               
            }catch(err){
                reject(err);
            }
        });
        return p;
    }
}

module.exports.Migrator = Migrator;