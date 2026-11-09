'use strict';

const Stomp  = require('stomp-client'); //https://github.com/ahudak/node-stomp-client
const guid = require('guid');
const EventEmitter = require('events'); //not 'node:events': services on Node 8 (node:carbon) use this file

class Queue {

    constructor(conf){
        this.conf = conf;
        this.listeners = []; //{fn, headers, mq} of every subscribe() - kept across reconnections
        this.event = new EventEmitter();

        this.create();
        this.connect().catch(()=>{}); //failures are already emitted as 'exception'
    }

    create(){
        this.mq = new Stomp(this.conf.host.replace("https://", "").replace("http://", ""), this.conf.port, this.conf.user, this.conf.password, "1.1", null, {retries: 10, delay:1000}, '5000,10000', this.conf.host.match(/https/i)? {}: null); 
        this.status = "not-connected";
        
        this.solver = Function(); //connection solver - notify the connect promise that is now connected
        
        this.connected = false;
        this.session = null;
        this.rdp = null;
        this.subscription = null; //id of the broker subscription on this connection (shared by all the listeners)
        this.ack = null;          //ack mode of that subscription

        var me = this;

        this.mq.on('reconnecting', ()=>{
            let date = new Date().toISOString();
            me.connected = false;
            me.event.emit('reconnecting', {timestamp: date, destination: me.conf.destination});
            console.info('%j',{timestamp: date, level: 'INFO', message: 'from ' + me.conf.destination + ' - reconnecting'});
        });
        this.mq.on('connect', ()=>{
            let date = new Date().toISOString();
            me.connected = true;
            me.resubscribe();
            me.event.emit('connect', {timestamp: date, destination: me.conf.destination});
            console.info('%j',{timestamp: date, level: 'INFO', message: 'from ' + me.conf.destination + ' - connect'});
        });
        this.mq.on('reconnect', ()=>{
            let date = new Date().toISOString();
            me.connected = true;
            me.solver(); //informs that connected (or reconnected)
            me.resubscribe();
            me.event.emit('reconnect', {timestamp: date, destination: me.conf.destination});
            console.info('%j',{timestamp: date, level: 'INFO', message: 'from ' + me.conf.destination + ' - reconnect'});
        });
        this.mq.on('error', (err)=>{
            let date = new Date().toISOString();
            me.event.emit('exception', {timestamp: date, destination: me.conf.destination, error: err});
            console.error('%j',{timestamp: date, level: 'ERROR', message: 'from ' + me.conf.destination + ' - ' + err.message + ' - ' + err.stack});
            
            if (err.message.includes("[reconnect attempts reached]")){
                me.connected = false;

                this.mq.removeAllListeners();
                this.mq.on('error', (err)=>{}); //supress
                this.mq.stopHeartBeats(); //the old client's heart-beat timers would keep running forever

                console.info('%j',{timestamp: date, level: 'INFO', message: 'reconnecting...'});
                this.mq.disconnect();
                me.rdp = null;
                
                this.create(); //connect - the listeners are subscribed again when the new connection is up
                this.connect().catch(()=>{});
            }
        });
    }

    connect(){
        var me = this;

       if(!me.rdp){
            var p = new Promise(function(resolve, reject){       
                me.solver = resolve;     //store the solver - if the connections has errors to connect instantly, then is the reconnect event that is raised - reconnect does not trigger the resolve() - we store to trigger manually 
                try {                   
                    //errors are handled by the 'error' listener of create()
                    me.mq.connect((session)=>{
                        me.session = session;
                        resolve();
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
        var me = this;
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

    //headers: optional subscribe headers, e.g. {ack: 'client-individual'} to ack topic messages with delete()
    //default ack: 'auto' for topics (nobody acks a broadcast; with client acks the broker stops delivering
    //once the prefetch limit, 32767 unacked messages, is reached) and 'client-individual' for queues.
    //A Queue has one broker subscription: the headers of its first subscribe() apply, later calls only add fn.
    //Resolves at once; when not connected yet, the subscription is sent as soon as the connection is up.
    subscribe(fn, headers){
        var me = this;
        var ack = /^\/topic\//i.test(me.conf.destination)? 'auto' : 'client-individual';
        var listener = {fn: fn, headers: { ack: ack, ...headers }, mq: null};

        me.listeners.push(listener);
        if (!me.connected) return Promise.resolve();

        try {
            me.listen(listener);
            return Promise.resolve();
        }catch(e){
            let date = new Date().toISOString();
            me.event.emit('exception', {timestamp: date, destination: me.conf.destination, error: e});
            return Promise.reject(e);
        }
    }

    //registers one listener on the current connection (the first one creates the broker subscription)
    listen(listener){
        var me = this;
        var id = me.subscription || guid.raw();
        me.mq.subscribe(me.conf.destination, listener.fn, { ...listener.headers, id: id });
        listener.mq = me.mq;

        if (!me.subscription){
            me.subscription = id;
            me.ack = listener.headers.ack;
        }
    }

    //registers the listeners that are not on the current connection yet: the ones added before it was up,
    //or all of them after a new connection was created. The client itself restores the ones it already knows.
    resubscribe(){
        var me = this;
        var pending = me.listeners.filter(listener => listener.mq !== me.mq);
        if (!pending.length) return;

        try {
            pending.forEach(listener => me.listen(listener));
            console.info('%j',{timestamp: new Date().toISOString(), level: 'INFO', message: 'from ' + me.conf.destination + ' - subscribed (' + pending.length + ')'});
        }catch(e){
            let date = new Date().toISOString();
            me.event.emit('exception', {timestamp: date, destination: me.conf.destination, error: e});
        }
    }

    delete(mid){
        var me = this;
        var p = new Promise(function(resolve, reject){
            if(me.subscription){
                try {
                    //with ack 'auto' the broker already considers the message delivered (an ACK would be an error)
                    if (me.ack !== 'auto') me.mq.ack(mid, me.subscription);
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
            if(me.listeners.length){
                try {
                    if (me.subscription && me.connected){
                        me.mq.unsubscribe(me.conf.destination, { id: me.subscription }); //STOMP 1.1 requires the id
                    } else {
                        delete me.mq.subscriptions[me.conf.destination]; //not connected: just stop the client from restoring it
                    }
                    me.listeners = [];
                    me.subscription = null;
                    me.ack = null;
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