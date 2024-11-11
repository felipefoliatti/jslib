'use strict';
const request = require('request-promise-native');

/**
 * 
 * 
 */

class Cache {
    cache = null;
    
    key = null;
    segregator = null;
    
    fn = null;
    topic = null;

    handler = null;
    chunk = null;

    static fn = {
        DEFAULT_REQUEST: ({uri, key, version, limit}) =>
            (async function ({segregator, keys}={}) { 
                return await request({
                    method: 'GET', 
                    uri: uri, 
                    qs: { 
                        version: (version || '1'), 
                        [this.segregator]: Array.isArray(segregator)? segregator.join(',') : segregator, 
                        [key ?? 'id']: keys.join(','), 
                        limit: (limit || keys.length || '*') 
                    },
                    json: true
                });
            }),
        
        DEFAULT_RESPONSE_HANDLER: ({key}={}) => ({ 
            getData: (response) => response.data, 
            getKey: (item) => ({key: key ?? 'id', value:this.getProperty(item, key ?? 'id')})
        }),
        
        DEFAULT_TOPIC_ID_HANDLER: ({key}={}) => 
            ((object) => object[key ?? 'id']),
    };
  
    static unique(array){
        let items = array.filter(Boolean); //remove empty entries
        let distinct = new Set(items);
        return Array.from(distinct) 
    }

    static getProperty(object, propertyName ) {
        var parts = propertyName.split( "." ),
            length = parts.length,
            i,
            property = object || this;
        
        for ( i = 0; i < length; i++ ) {
            property = property[parts[i]];
        }
        
        return property;
    }
  
    constructor({cache, segregator, topic, key, fn, handler, chunk}={}){
        this.cache = cache;
        this.segregator = segregator;
        this.topic = topic;
        this.key = key;
        this.fn = fn;
        this.handler = handler;
        this.chunk = chunk || 100;

        let me = this;
        //in case of connection lost, clear the cache
        this.topic.event.on('reconnecting', ()=>{
            let keys = me.cache.keys().filter(key => key.startsWith(me.key));
            keys.forEach(key => me.cache.del(key));
            console.log(`${me.key} - ${new Date().toISOString()} - connection problem to topic - cache cleared - keys: `, keys.length);
        })

        //subscribe to topic 
        this.topic.subscribe((data) => {
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

                            //retrieve the object to check if it is a map
                            let oentry = this.cache.get(entry);
                            let entries = [];


                            //append to array if the object was found in the cache
                            if (oentry){
                               entries.push(entry);
                            }

                            //in this case, we have a map, add also the reference
                            if (oentry && typeof oentry != 'object'){
                                entries.push(`${key}:${oentry}`)
                            }

                            if (entries.length){
                                console.log(`${key} - ${new Date().toISOString()} - cache deleted entry(is): [${entries}]`);
                                this.cache.del(entries);
                            }
                        }
                    }
                }
            } catch(ex){
                console.log(`${key} - ${new Date().toISOString()} - wrong data received: ${data}`);
            }
        });
    }   

    async get({segregator, keys}={}){
        
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
                let data = [];
                let i = 0;

                //chunk reads
                do{
                    let keys = missing.slice(i, i + this.chunk);
                    let response = await this.fn.apply(this, [{segregator: segregator, keys: keys}]);
                    //process the response
                    let odata = this.handler.response.getData(response);
                    
                    //append to array
                    data.push(...odata);
                    //sum the read items
                    i = i + this.chunk;
                } 
                while(i < missing.length);
            
                // let data = this.handler.response.getData(response);
            
                //iterate over item and cache it
                for (let i=0; i < data.length; i++){
                    let object = data[i];
                    let pair = this.handler.response.getKey(object);

                    //add to cache and cached
                    this.cache.set(`${this.key}:${pair.value}`, object);

                    //create the map to clean when an topic notify changes
                    if (pair.key != 'id') this.cache.set(`${this.key}:${object.id}`, pair.value);

                    //add to cache 
                    if (missing.indexOf(pair.value) != -1) {
                        cached.push(object);
                    }
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