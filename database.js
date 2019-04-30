'use strict';

const mysql = require('mysql');

class Database {

     constructor(config){
        this.drivername = config.drivername;
        this.database = config.database;
        this.user= config.user;
        this.password = config.password;
        this.host= config.host;
        this.port = config.port;
        this.multiple = config.multiple;
    }

    query(sql, values){
        var me = this;
        var p = new Promise((resolve, reject)=>{
            
            try{
                
                if(!this.pool){
                    this.pool = mysql.createPool({  
                        host              : me.host,
                        user              : me.user,
                        password          : me.password,
                        database          : me.database,
                        multipleStatements: me.multiple||false
                    });
                }
                
                this.pool.getConnection(function(err, con) {
                    
                    if(err){
                        reject(err);
                    }
                    else {
                        con.query(sql, values, function (err, result) {
                            con.release();
                            
                            if (err) {
                                reject(err);
                            }
                            resolve(result);

                        });
                    }
                    
                });
            }catch(err){
                reject(err);
            }
        });
        return p;
    }
}

module.exports.Database = Database;