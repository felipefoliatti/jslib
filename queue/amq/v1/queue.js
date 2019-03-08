'use strict';

const Stomp  = require('stomp-client'); //https://github.com/ahudak/node-stomp-client
const guid = require('guid');

class Queue {

    constructor(conf){
        this.conf = conf;
        //this.queueName = queueName;
        //this.queueSufix = queueSufix;
        //this.visibilityTimeout = visibilityTimeout;
        //this.mq = new Stomp('127.0.0.1', 61613, 'user', 'pass'); //new aws.SQS({region:this.conf.region, endpoint: this.conf.endpoint, credentials : new aws.Credentials(this.conf.key, this.conf.secret)});
        this.mq = new Stomp(this.conf.host.replace("https://", "").replace("http://", ""), this.conf.port, this.conf.user, this.conf.password, "1.1", null, {retries: 10, delay:1000}, this.conf.host.match(/https/i)? {}: null,'1000,2000'); 
        this.status = "not-connected";
        
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
            console.info('%j',{timestamp: new Date().toISOString(), level: 'INFO', message: 'from ' + me.conf.destination + ' - reconnect'});
        });
        this.mq.on('error', (err)=>{
            console.error('%j',{timestamp: new Date().toISOString(), level: 'INFO', message: 'from ' + me.conf.destination + ' - ' + err.message + ' - ' + err.stack});
        });
    }

    ready(){
        var me = this;
        if(!me.rdp){
            var p = new Promise(function(resolve, reject){
            
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
        
           
            // client.subscribe(destination, function(body, headers) {
            //   console.log('This is the body of a message on the subscribed queue:', body);
            // });
        
            // client.publish(destination, 'Oh herrow');


        // var me = this;
        // var p = new Promise(function(resolve, reject){     
        //     if(me.url){
        //         resolve();
        //     }
        //     else{
        //         me.sqs.listQueues({QueueNamePrefix : me.conf.queueName})
        //                 .promise()
        //                 .then(function (result){
        //                         if(result.QueueUrls){
        //                             return { QueueUrl: result.QueueUrls[0] }
        //                         }

        //                         var attr = { 'VisibilityTimeout':  me.conf.visibilityTimeout && me.conf.visibilityTimeout.toString() || '30' };
        //                         if(me.isFifo) attr.FifoQueue= 'true';

        //                         return me.sqs.createQueue({ QueueName : me.conf.queueName + me.conf.queueSufix, Attributes: attr}).promise();
        //                     })
        //                     .then(function(result){
        //                         me.url = result.QueueUrl;
        //                         resolve();
        //                     })
        //                     .catch(function(err){
        //                         reject(err);
        //                     });
        //     }
        // });
        //return p;
    }

    alive(){
        return !this.mq.stream.connecting && this.mq.stream.writable && this.connected;
    }

    send(content) {

        var id = guid.raw();
        var sent = false;

        if (this.alive()){
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

       
        // var param = {MessageBody: content, QueueUrl: this.url};
        
        // if(this.isFifo) {
        //     param.MessageDeduplicationId = guid.raw();
        //     param.MessageGroupId= 'main';
        // }
        
        // return this.sqs.sendMessage(param).promise();
    }

    subscribe(fn){
        var me = this;
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

    delete(mid){
        var me = this;
        var p = new Promise(function(resolve, reject){
            if(me.subscription){
                try {
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