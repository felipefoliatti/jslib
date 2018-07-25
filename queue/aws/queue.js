'use strict';

const aws  = require('aws-sdk');
const guid = require('guid');

class Queue {

    constructor(conf){
        this.conf = conf;
        //this.queueName = queueName;
        //this.queueSufix = queueSufix;
        //this.visibilityTimeout = visibilityTimeout;
        this.sqs = new aws.SQS({region:this.conf.region, endpoint: this.conf.endpoint, credentials : new aws.Credentials(this.conf.key, this.conf.secret)});
        this.url = null;
        this.isFifo = this.conf.queueSufix == ".fifo";   
    }

    attr(attributes){
        var me = this;
        var p = new Promise(function(resolve, reject){     
        
            me.sqs.getQueueAttributes({ QueueUrl: me.url, AttributeNames: attributes || ["All"] })
                    .promise()
                    .then(function (result){
                        resolve(result);
                    })
                    .catch(function(err){
                        reject(err);
                    });    
        });
        return p;
    }

    ready(){
        var me = this;
        var p = new Promise(function(resolve, reject){     
            if(me.url){
                resolve();
            }
            else{
                me.sqs.listQueues({QueueNamePrefix : me.conf.queueName})
                        .promise()
                        .then(function (result){
                                if(result.QueueUrls){
                                    return { QueueUrl: result.QueueUrls[0] }
                                }

                                var attr = { 'VisibilityTimeout':  me.conf.visibilityTimeout && me.conf.visibilityTimeout.toString() || '30' };
                                if(me.isFifo) attr.FifoQueue= 'true';

                                return me.sqs.createQueue({ QueueName : me.conf.queueName + me.conf.queueSufix, Attributes: attr}).promise();
                            })
                            .then(function(result){
                                me.url = result.QueueUrl;
                                resolve();
                            })
                            .catch(function(err){
                                reject(err);
                            });
            }
        });
        return p;
    }

    send(content) {
        var param = {MessageBody: content, QueueUrl: this.url};
        
        if(this.isFifo) {
            param.MessageDeduplicationId = guid.raw();
            param.MessageGroupId= 'main';
        }
        
        return this.sqs.sendMessage(param).promise();
    }

    read(){
        return this.sqs.receiveMessage({WaitTimeSeconds: 20, QueueUrl: this.url}).promise();    
    }

    delete(handle){
        return this.sqs.deleteMessage({QueueUrl: this.url,  ReceiptHandle: handle}).promise();
    }

}
module.exports.Queue = Queue