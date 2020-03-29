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

                            const results = {};
                            conn.beginTransaction((err) => {
                                if (err) {
                                    reject(err);
                                }
    
                                // Loop through all queries
                                for (var i in queries) {
                                    var query = queries[i];
    
                                    con.query(query.sql, query.values, (err, queryResults, fields) => {
                                        // If the query errored, then rollback and reject
                                        if (err) {
                                            // Try catch the rollback end reject if the rollback fails
                                            conn.rollback((err) => {
                                                throw err;
                                            });
                                            
                                        }
                                        // Push the result into an array and index it with the ID passed for searching later
                                        results[i] = {
                                            result: queryResults,
                                            fields: fields,
                                        };
                                    });
                                }
                
                                // If all loops have itterated and no errors, then commit
                                this.connection.commit((err) => {
                                    if (err) {
                                        throw e;
                                    }
                                    resolve(results);
                                });
                            });
                        } catch (error) {
                            con.release();
                            reject(error);
                        }

                    }
                    
                    con.release();
                    resolve(aresults);
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