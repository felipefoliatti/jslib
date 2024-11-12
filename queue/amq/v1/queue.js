'use strict';

const Stomp  = require('stomp-client'); //https://github.com/ahudak/node-stomp-client
const guid = require('guid');
const EventEmitter = require('node:events');

class Queue {

    constructor(conf){
        this.conf = conf;
        this.saction = Function();//empty subscription action
        this.event = new EventEmitter();

        this.create();
        this.connect();
    }

    create(){
        this.mq = new Stomp(this.conf.host.replace("https://", "").replace("http://", ""), this.conf.port, this.conf.user, this.conf.password, "1.1", null, {retries: 10, delay:1000}, '5000,10000', this.conf.host.match(/https/i)? {}: null); 
        this.status = "not-connected";
        
        this.solver = Function(); //connection solver - notify the connect promise that is now connected
        
        this.connected = false;
        this.session = null;
        this.rdp = null;
        this.subscription = null;        

        var me = this;

        this.mq.on('end', ()=>{
            let date = new Date().toISOString();
            me.connected = false;
            me.event.emit('end', {timestamp: date, destination: me.conf.destination});
            console.info('%j',{timestamp: date, level: 'INFO', message: 'from ' + me.conf.destination + ' - disconnected'});
        });
        this.mq.on('reconnecting', ()=>{
            let date = new Date().toISOString();
            me.connected = false;
            me.event.emit('reconnecting', {timestamp: date, destination: me.conf.destination});
            console.info('%j',{timestamp: date, level: 'INFO', message: 'from ' + me.conf.destination + ' - reconnecting'});
        });
        this.mq.on('connect', ()=>{
            let date = new Date().toISOString();
            me.connected = true;
            me.event.emit('connect', {timestamp: date, destination: me.conf.destination});
            console.info('%j',{timestamp: date, level: 'INFO', message: 'from ' + me.conf.destination + ' - connect'});
        });
        this.mq.on('reconnect', ()=>{
            let date = new Date().toISOString();
            me.connected = true;
            me.solver(); //informs that connected (or reconnected)
            me.event.emit('reconnect', {timestamp: date, destination: me.conf.destination});
            console.info('%j',{timestamp: date, level: 'INFO', message: 'from ' + me.conf.destination + ' - reconnect'});
        });
        this.mq.on('error', (err)=>{
            let date = new Date().toISOString();
            me.event.emit('exception', {timestamp: date, destination: me.conf.destination, error: err});
            console.error('%j',{timestamp: date, level: 'INFO', message: 'from ' + me.conf.destination + ' - ' + err.message + ' - ' + err.stack});
            
            if (err.message.includes("[reconnect attempts reached]")){
                me.connected = false;

                this.mq.removeAllListeners();
                this.mq.on('error', (err)=>{}); //supress

                console.info('%j',{timestamp: date, level: 'INFO', message: 'reconnecting...'});
                this.mq.disconnect();
                me.rdp = null;
                
                this.create(); //connect
                this.connect()
                    .then(() => this.saction()).then(()=> console.info('%j',{timestamp: new Date().toISOString(), level: 'INFO', message: 'from ' + me.conf.destination + ' - resubscribed'}));//redo the subscriptions
            }
        });
    }

    connect(){
        var me = this;

       if(!me.rdp){
            var p = new Promise(function(resolve, reject){       
                me.solver = resolve;     //store the solver - if the connections has errors to connect instantly, then is the reconnect event that is raised - reconnect does not trigger the resolve() - we store to trigger manually 
                try {                   
                    me.mq.connect((session)=>{
                        me.session = session;
                        resolve();
                    }, (err) => {
                        let date = new Date().toISOString();

                        me.event.emit('exception', {timestamp: date, destination: me.conf.destination, error: err});
                        console.error('%j',{timestamp: date, level: 'ERROR', message: 'from ' + me.conf.destination + ' - ' + err.message + ' - ' + err.stack});
                    });
                    
                }catch(e){                        
                    let date = new Date().toISOString();
                    me.event.emit('exception', {timestamp: date, destination: me.conf.destination, error: e});

                    me.rdp = null;
                    reject(e);
                }
        
            });

            me.rdp = p;
            return p;

        } else {
            return me.rdp;
        }
        
    
    }

    alive(){
        return this.connected && !this.mq.stream.connecting && this.mq.stream.writable;
    }

    send(content) {

        var id = guid.raw();
        var promise;
            
        //check if it is able to send
        if (this.alive()){         
            //try to send it and wait the promise resolve with server response           
            promise = this.mq.publish(this.conf.destination, content, {'persistent': true, 'content-type': 'application/json', 'correlation-id': id});               
            return promise.then(e => id); //return the id
        } else {
            let date = new Date().toISOString();
            let error = new Error('unable to write to queue')
            me.event.emit('exception', {timestamp: date, destination: me.conf.destination, error: error});

            //if it is unable to send, reject with an error
            return Promise.reject(error);
        }

    }

    subscribe(fn){
        var me = this;
        //store the subscription action - when reconnect - it will be called again
        me.saction=()=> {

            var p = new Promise(function(resolve, reject){
                try{
                    var id = guid.raw();
                    me.mq.subscribe(me.conf.destination, fn, { id: id, ack: 'client-individual' });
                    me.subscription = id;
                    resolve();
                }catch(e){

                    let date = new Date().toISOString();
                    me.event.emit('exception', {timestamp: date, destination: me.conf.destination, error: e});
                    reject(e);
                }
            });
            return p;    
        }
        //run the subscribe
        return me.saction();
    }

    delete(mid){
        var me = this;
        var p = new Promise(function(resolve, reject){
            if(me.subscription){
                try {
                    me.saction = Function(); //clear the subscription action if any
                    me.mq.ack(mid, me.subscription);
                    resolve();
                }catch(e){
                    let date = new Date().toISOString();
                    me.event.emit('exception', {timestamp: date, destination: me.conf.destination, error: e});
                    reject(e);
                }
            } else {

                let date = new Date().toISOString();
                let error = new Error('no subscription active, call "subscribe" before')
                me.event.emit('exception', {timestamp: date, destination: me.conf.destination, error: error});

                reject(error)
            }
        });
        return p;
    }

    unsubscribe(){
        var me = this;
        var p = new Promise(function(resolve, reject){
            if(me.subscription){
                try {
                    me.mq.unsubscribe(me.conf.destination);
                    me.subscription = null;
                    resolve();
                }catch(e){
                    let date = new Date().toISOString();
                    me.event.emit('exception', {timestamp: date, destination: me.conf.destination, error: e});
                    reject(e);
                }
            } else {
                let date = new Date().toISOString();
                let error = new Error('no subscription active, nothing to unsubscribe')
                me.event.emit('exception', {timestamp: date, destination: me.conf.destination, error: error});
                reject(error)
            }
        });
        return p;
    }



    

}
module.exports.Queue = Queue