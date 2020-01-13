'use strict';

var Stomp = require('stompjs-websocket');
//const Stomp  = require('stomp-client'); //https://github.com/ahudak/node-stomp-client
const guid = require('guid');

class Queue {

    constructor(conf){
        this.conf = conf;
        //this.queueName = queueName;
        //this.queueSufix = queueSufix;
        //this.visibilityTimeout = visibilityTimeout;
        //this.mq = new Stomp('127.0.0.1', 61613, 'user', 'pass'); //new aws.SQS({region:this.conf.region, endpoint: this.conf.endpoint, credentials : new aws.Credentials(this.conf.key, this.conf.secret)});
        
        this.mq = Stomp.client("ws://" + this.conf.host + ":" + this.conf.port);
        //this.mq = Stomp.client(this.conf.host.replace("https://", "wss://").replace("http://", "ws://") + ":" + this.conf.port);
        this.mq.heartbeat.outgoing = 20000; // client will send heartbeats every 20000ms
        this.mq.heartbeat.incoming = 0;     // client does not want to receive heartbeats from the server
        
        // Add the following if you need automatic reconnect (delay is in milli seconds)
        this.mq.reconnect_delay = 1000;

        //this.mq = new Stomp(this.conf.host.replace("https://", "").replace("http://", ""), this.conf.port, this.conf.user, this.conf.password, "1.1", null, {retries: 10, delay:1000}, this.conf.host.match(/https/i)? {}: null,'1000,1000'); 
        this.status = "not-connected";
        
        this.session = null;
        this.rdp = null;
        this.subscription = null;


        // this.mq.on('connect', ()=>{
        //     console.info('%j',{timestamp: new Date().toISOString(), level: 'INFO', message: 'from ' + me.conf.destination + ' - connect'});
        // });
        // this.mq.on('reconnect', ()=>{
        //     console.info('%j',{timestamp: new Date().toISOString(), level: 'INFO', message: 'from ' + me.conf.destination + ' - reconnect'});
        // });
        // this.mq.on('error', (err)=>{
        //     console.error('%j',{timestamp: new Date().toISOString(), level: 'INFO', message: 'from ' + me.conf.destination + ' - ' + err.message + ' - ' + err.stack});
        // });
    }

    ready(){
        var me = this;
        if(!me.rdp){
            var p = new Promise(function(resolve, reject){
            
                    try {

                        var headers = {
                            login: me.conf.user, 
                            passcode: me.conf.password,
                            // additional header
                            //'client-id': 'my-client-id'
                        };
                        console.log(me.mq);
                        me.mq.connect(headers, /*success*/function() {
                            console.info('%j',{timestamp: new Date().toISOString(), level: 'INFO', message: 'from ' + me.conf.destination + ' - connected'});
                            resolve();
                        }, /* error */ function(error) {
                            var message = (error.headers && error.headers.message) || error;
                            console.error('%j',{timestamp: new Date().toISOString(), level: 'ERROR', message: 'from ' + me.conf.destination + ' - ' + message })
                            reject(new Error(message));
                        });

                        //me.mq.connect()

                        // me.mq.connect((session)=>{
                        //     me.session = session;
                        //     resolve();
                        // }, (err) => {
                        //     console.error('%j',{timestamp: new Date().toISOString(), level: 'ERROR', message: 'from ' + me.conf.destination + ' - ' + err.message + ' - ' + err.stack});
                        // });
                        
                    }catch(err){
                        me.rdp = null;
                        console.error('%j',{timestamp: new Date().toISOString(), level: 'ERROR', message: 'from ' + me.conf.destination + ' - ' + err.message + ' - ' + err.stack});
                        reject(err);
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

    send(content) {
        var id = guid.raw();
        this.mq.send(this.conf.destination, {'persistent': true, 'content-type': 'application/json', 'correlation-id': id}, content);
        //this.mq.publish(this.conf.destination, content, {'persistent': true, 'content-type': 'application/json', 'correlation-id': id});
        return id;
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

        // var me = this;
        // var p = new Promise(function(resolve, reject){
        //     try{
        //         var id = guid.raw();
        //         me.mq.subscribe(me.conf.destination, fn, { id: id, ack: 'client-individual' });
        //         me.subscription = id;
        //         resolve();
        //     }catch(e){
        //         reject(e);
        //     }
        // });
        // return p;    
    }

    nack(mid){
        var me = this;
        var p = new Promise(function(resolve, reject){
            if(me.subscription){
                try {
                    me.mq.nack(mid, me.subscription);
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

    ack(mid){
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
                    me.mq.unsubscribe(me.subscription);
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
        // var me = this;
        // var p = new Promise(function(resolve, reject){
        //     if(me.subscription){
        //         try {
        //             me.mq.unsubscribe(me.conf.destination);
        //             me.subscription = null;
        //             resolve();
        //         }catch(e){
        //             reject(e);
        //         }
        //     } else {
        //         reject(new Error('no subscription active, nothing to unsubscribe'))
        //     }
        // });
        // return p;
    }

    

}
module.exports.Queue = Queue