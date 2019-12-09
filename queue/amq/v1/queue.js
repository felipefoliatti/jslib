'use strict';

const Stomp  = require('stomp-client'); //https://github.com/ahudak/node-stomp-client
const guid = require('guid');

class Queue {

    constructor(conf){
        this.conf = conf;
        this.saction = Function();//empty subscription action

        this.create();
        this.connect();
    }

    create(){
        this.mq = new Stomp(this.conf.host.replace("https://", "").replace("http://", ""), this.conf.port, this.conf.user, this.conf.password, "1.1", null, {retries: 10, delay:1000}, this.conf.host.match(/https/i)? {}: null,'1000,2000'); 
        this.status = "not-connected";
        
        this.solver = Function(); //connection solver - notify the connect promise that is now connected
        
        this.connected = false;
        this.session = null;
        this.rdp = null;
        this.subscription = null;        

        var me = this;

        this.mq.on('end', ()=>{
            me.connected = false;
            console.info('%j',{timestamp: new Date().toISOString(), level: 'INFO', message: 'from ' + me.conf.destination + ' - disconnected'});
        });
        this.mq.on('connect', ()=>{
            me.connected = true;
            console.info('%j',{timestamp: new Date().toISOString(), level: 'INFO', message: 'from ' + me.conf.destination + ' - connect'});
        });
        this.mq.on('reconnect', ()=>{
            me.connected = true;
            me.solver(); //informs that connected (or reconnected)
            console.info('%j',{timestamp: new Date().toISOString(), level: 'INFO', message: 'from ' + me.conf.destination + ' - reconnect'});
        });
        this.mq.on('error', (err)=>{
            console.error('%j',{timestamp: new Date().toISOString(), level: 'INFO', message: 'from ' + me.conf.destination + ' - ' + err.message + ' - ' + err.stack});
            
            if (err.message.includes("[reconnect attempts reached]")){
                me.connected = false;

                this.mq.removeAllListeners();
                this.mq.on('error', (err)=>{}); //supress

                console.info('%j',{timestamp: new Date().toISOString(), level: 'INFO', message: 'reconnecting...'});
                this.mq.disconnect();
                me.rdp = null;
                this.create(); //connect
                this.connect().then(() => this.saction()); //redo the subscriptions
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
                        console.error('%j',{timestamp: new Date().toISOString(), level: 'ERROR', message: 'from ' + me.conf.destination + ' - ' + err.message + ' - ' + err.stack});
                    });
                    
                }catch(e){
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
        var sent = false;
            
        if (this.alive()){
            //try to send
            this.mq.publish(this.conf.destination, content, {'persistent': true, 'content-type': 'application/json', 'correlation-id': id});               
            //check again to garantee the connection is alive before return the confirmation id
            sent = this.alive();  
        }
        
        if (sent){
            return id;
        } else {
            var err = new Error('unable to write to queue')
            this.mq.stream.emit('error', err)
            throw err;
        }
    }

    subscribe(fn){
        var me = this;
        //store the subscription action - when reconnect - it will be called again
        this.saction=()=> {
            console.log("redoing!!")            
            var p = new Promise(function(resolve, reject){
                try{
                    var id = guid.raw();
                    me.mq.subscribe(me.conf.destination, fn, { id: id, ack: 'client-individual' });
                    me.subscription = id;
                    resolve();
                }catch(e){
                    reject(e);
                }
            });
            return p;    
        }
        //run the subscribe
        return this.saction();
    }

    delete(mid){
        var me = this;
        var p = new Promise(function(resolve, reject){
            if(me.subscription){
                try {
                    this.saction = Function(); //clear the subscription action if any
                    me.mq.ack(mid, me.subscription);
                    resolve();
                }catch(e){
                    reject(e);
                }
            } else {
                reject(new Error('no subscription active, call "subscribe" before'))
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
                    reject(e);
                }
            } else {
                reject(new Error('no subscription active, nothing to unsubscribe'))
            }
        });
        return p;
    }

    

}
module.exports.Queue = Queue