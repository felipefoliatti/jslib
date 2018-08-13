'use strict';


const stompit = require('stompit');
const guid = require('guid');

class Queue {

    constructor(conf){

        this.conf = conf;
        //this.queueName = queueName;
        //this.queueSufix = queueSufix;
        //this.visibilityTimeout = visibilityTimeout;
        //this.mq = new Stomp('127.0.0.1', 61613, 'user', 'pass'); //new aws.SQS({region:this.conf.region, endpoint: this.conf.endpoint, credentials : new aws.Credentials(this.conf.key, this.conf.secret)});
        //this.mq = new Stomp(this.conf.host.replace("https://", "").replace("http://", ""), this.conf.port, this.conf.user, this.conf.password, "1.0", null, {retries: 10, delay:1000}, this.conf.host.match(/https/i)? {}: null); 
        this.status = "not-connected";
        
        this.client = null;
        this.rdp = null;
        this.subscription = null;
  
    }

    ready(){
        var me = this;
        if(!me.rdp){
            var p = new Promise(function(resolve, reject){
            
                    try {
            
                        var options = {
                            'host': this.conf.host.replace("https://", "").replace("http://", ""),
                            'port': this.conf.port,
                            'ssl': this.conf.host.match(/https/i),
                            'connectHeaders':{
                              'login': this.conf.user,
                              'passcode': this.conf.password,
                              'heart-beat': '5000,5000'
                            }
                        };

                        stompit.connect(options, function(error, client) {
                            if (error) reject(error);
                            me.client = client;
                            resolve()
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

    send(content) {
        var id = guid.raw();
        var headers = {
            'destination': this.conf.destination,
            'content-type': 'application/json',
            'persistent': true,
            'correlation-id': id
        };
        
        var frame = client.send(headers);
        frame.write(content);
        frame.end();

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
        
    
        var me = this;
        var p = new Promise(function(resolve, reject){
            try{
                var id = guid.raw();
                var headers = {
                    'id': id,
                    'destination': '/queue/test',
                    'ack': 'client-individual'
                };
                me.client.subscribe(headers, function(err, message){
                    
                    //creates a new method to use async/await
                    message.content = new Promise(function(rs, rj){
                        message.readString('utf-8', function(error, body) {
                            if(error) rs(error);
                            rj(body);
                        });
                    })
                    
                    fn(headers, message);
                });
                resolve();
            }catch(e){
                reject(e);
            }
        });
        return p;    
    }

    ack(message){
        var me = this;
        var p = new Promise(function(resolve, reject){
            if(me.client){
                try {
                    me.client.ack(message);
                    resolve();
                }catch(e){
                    reject(e);
                }
            } else {
                reject(new Error('no client connected, call "ready" before'))
            }
        });
        return p;
    }

    nack(message){
        var me = this;
        var p = new Promise(function(resolve, reject){
            if(me.client){
                try {
                    me.client.nack(message);
                    resolve();
                }catch(e){
                    reject(e);
                }
            } else {
                reject(new Error('no client connected, call "ready" before'))
            }
        });
        return p;
    }

    disconnect(){
        var me = this;
        var p = new Promise(function(resolve, reject){
            if(me.client){
                try {
                    me.client.disconnect();
                    me.client = null;
                    resolve();
                }catch(e){
                    reject(e);
                }
            } else {
                reject(new Error('no client active, nothing to disconnect'))
            }
        });
        return p;
    }

    

}
module.exports.Queue = Queue