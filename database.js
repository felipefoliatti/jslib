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
        this.connectionLimit = config.connectionLimit;
    }

    queries(queries){
        var me = this;
        var p = new Promise((resolve, reject)=>{
            
            try{
                
                if(!this.pool){
                    this.pool = mysql.createPool({  
                        connectionLimit   : me.connectionLimit || 1,
                        host              : me.host,
                        user              : me.user,
                        password          : me.password,
                        database          : me.database,
                        multipleStatements: me.multiple||false
                    });
                }
                
                this.pool.getConnection(function(err, con) {
                         
                    if(err){
                        con.release();
                        reject(err);
                    }
                    else {
                    
                        try {

                            var results = [];
                            con.beginTransaction((err) => {
                                
                                var run = (i) => {
                                    if (queries[i]){
                                        //run one more
                                        con.query(queries[i].sql, queries[i].values, (err, queryResults, fields) => {
                                            if (!err){
                                                
                                                results[i] = {
                                                    result: queryResults,
                                                    fields: fields,
                                                };

                                                //run one more
                                                run(++i);

                                            } else {
                                                con.rollback(err => {});
                                                con.release();
                                                reject(err);
                                            }
                                        });

                                    } else {
                                        //all run successfull
                                        con.commit(err => {
                                            con.release();
                                            if (err){
                                                reject(err);
                                            } else {
                                                resolve(results);
                                            }
                                        });

                                    }

                                    
                                };

                                //start
                                run(0);
                                
                            });

                        } catch (error) {
                            con.release();
                            reject(error);
                        }
                    }
                    //me.pool.end();
                });

            }catch(err){
                reject(err);
            }
        });
        return p;
    }

    query(sql, values){
        var me = this;
        var p = new Promise((resolve, reject)=>{
            
            try{
                
                if(!this.pool){
                    this.pool = mysql.createPool({  
                        connectionLimit   : me.connectionLimit || 1,
                        host              : me.host,
                        user              : me.user,
                        password          : me.password,
                        database          : me.database,
                        multipleStatements: me.multiple||false
                    });
                }
                
                this.pool.getConnection(function(err, con) {
                    
                    if(err){
                        con.release();
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
                    
                    //me.pool.end();
                });
            }catch(err){
                reject(err);
            }
        });
        return p;
    }
}

module.exports.Database = Database;
