'use strict';

const Stomp  = require('stomp-client');
const guid = require('guid');

class Queue {

    constructor(conf){
        this.conf = conf;
        //this.queueName = queueName;
        //this.queueSufix = queueSufix;
        //this.visibilityTimeout = visibilityTimeout;
        //this.mq = new Stomp('127.0.0.1', 61613, 'user', 'pass'); //new aws.SQS({region:this.conf.region, endpoint: this.conf.endpoint, credentials : new aws.Credentials(this.conf.key, this.conf.secret)});
        this.mq = new Stomp(this.conf.host.replace("https://", "").replace("http://", ""), this.conf.port, this.conf.user, this.conf.password, "1.0", null, {retries: 10, delay:1000}, this.conf.host.match(/https/i)? {}: null); 
        this.status = "not-connected";
        
        this.session = null;
        this.rdp = null;
    }

    ready(){
        var me = this;
        if(!me.rdp){
            var p = new Promise(function(resolve, reject){
            
                    try {
                        me.mq.connect(function(session){
                            me.session = session;
                            resolve();
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
        this.mq.publish(this.conf.destination, content, {'persistent': true, 'content-type': 'application/json', 'correlation-id': id});
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
                resolve(id);
            }catch(e){
                reject(e);
            }
        });
        return p;    
    }

    delete(mid, sid){
        var me = this;
        var p = new Promise(function(resolve, reject){
            try {
                me.mq.ack(mid, sid);
                resolve();
            }catch(e){
                reject(e);
            }
        });
        return p;
    }

}
module.exports.Queue = Queue