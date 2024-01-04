'use strict';
const request = require('request-promise-native');

/**
 * 
 * 
 */

class Cache {

    topic = null;
    cache = null;
    key = null;
    fn = null;
    handler = null;

    static fn = {
        DEFAULT_REQUEST: ({uri, version, limit}={}) => (async ({company, keys}={}) => await request({method: 'GET', uri: uri, qs: { version: (version || '1'), company: company, id: keys.join(','), limit: (limit || '*') },json: true})),
        DEFAULT_RESPONSE_HANDLER: { getData: (response) => response.data, getKey: (item) => item.id },
        DEFAULT_TOPIC_ID_HANDLER: (object) => object.id,
    };
  
    // static assign(...objects){
    //   return objects.reduce((p, c) => Object.assign(p, c), {})
    // }

    // static require(array, count){
    //   if (!array || array.length != count){ throw new Error('invalid filter, requiring two arguments: ' + array) }
    //   return array;
    // }

    static unique(array){
        let items = array.filter(Boolean); //remove empty entries
        let distinct = new Set(items);
        return Array.from(distinct) 
    }
  
    constructor({cache, topic, key, fn, handler}={}){
        this.cache = cache;
        this.topic = topic;
        this.key = key;
        this.fn = fn;
        this.handler = handler;

        //subscribe to topic 
        this.topic.subscribe((data) =>{
            try{
                //can receive null for keep-alive
                if (data != null && data != "null"){
                    var odata = JSON.parse(data);
                    let objects = Array.isArray(odata)? odata : [odata];
                    
                    //iterate over messages 
                    for(let i in objects){
                        var object = objects[i];

                        if (object.type == 1 || object.type == 2){
                            
                            let id = this.handler.topic(object);
                            let entry = `${key}:${id}`;

                            console.log(`${key} - ${new Date().toISOString()} - cache deleted ${entry}`);
                            this.cache.del(entry);
                        }
                    }
                }
            } catch(ex){
                console.log(`${key} - ${new Date().toISOString()} - wrong data received: ${data}`);
            }
        });
    }   

    async get({company, keys}={}){
        
        keys = Cache.unique(keys);

        let missing = [];
        let cached = [];

        //try to get from cache
        for(let i=0; i< keys.length; i++){
            let id = keys[i];
            let item = this.cache.get(`${this.key}:${id}`);
            
            if (item){
                cached.push(item);
            } else {
                missing.push(id);
            }

        }   

        if (missing.length){
            try{
                //request missing items
                let response = await this.fn({company: company, keys: missing});
            
                //process the response
                let data = this.handler.response.getData(response)
            
                //iterate over item and cache it
                for (let i=0; i < data.length; i++){
                    let object = data[i];
                    let key = this.handler.response.getKey(object);

                    //add to cache and cached
                    this.cache.set(`${this.key}:${key}`, object);
                    cached.push(object);
                }
            } 
            catch(ex){
                console.error(ex);
                throw ex;
            }

        }

        //return all cached data
        return cached;
    }
}  

module.exports = Cache