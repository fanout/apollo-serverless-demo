# Apollo serverless demo

This project uses [fanout-graphql-tools](https://github.com/fanout/fanout-graphql-tools) to demonstrate how to implement GraphQL subscriptions when [Apollo Server](https://www.apollographql.com/) is deployed on AWS Lambda. WebSocket connection management is delegated to [Fanout Cloud](https://fanout.io) such that Apollo does not require long-lived execution. There is no change to the wire protocol; Fanout is invisible to the GraphQL client.

There is a public deployment here: https://apollo.fanoutapp.com/

## Usage

The demo is a basic GraphQL service with no frontend, although if the service is accessed from a browser then the [GraphQL Playground](https://github.com/prisma/graphql-playground) will be loaded for easy testing. The service exposes an API for working with text notes. Below are some example operations to try.

Subscribing to new notes:

```graphql
subscription {
  noteAddedToChannel(channel:"#general") {
    content,
    id,
    channel,
  }
}
```

Adding a note:

```graphql
mutation {
  addNote(note:{
    channel:"#general",
    content:"just making a note",
  }) {
    id,
    channel,
    content,
  }
}
```

If you load the playground in two browser tabs, start a subscription in one and make a mutation from the other, then you'll see an update arrive over the subscription in realtime.

Here's an example of listening for updates using `wscat`:

```sh
$ wscat -c wss://apollo.fanoutapp.com/
connected (press CTRL+C to quit)
> {"type":"connection_init","payload":{}}
< {"type":"connection_ack"}
> {"id":"1","type":"start","payload":{"variables":{},"extensions":{},
"operationName":null,"query":"subscription { noteAddedToChannel(channel: 
\"#general\") { content id channel }}"}}
< {"id":"1","payload":{"data":{"noteAddedToChannel":{"content":"just making 
a note","id":"ade8def3-cbee-43f1-bd30-29d3671c6e8d","channel":"#general"}}},
"type":"data"}
```

## How it works

At a high level:

* Fanout Cloud manages the WebSocket connections.
* Lambda (with API Gateway) runs the Apollo server, which is where the application logic lives.
* DynamoDB is used to store GraphQL subscription state.

All WebSocket messages from the client are enveloped in an HTTP request and forwarded to the Apollo server. Apollo sends control messages in HTTP responses to associate WebSocket connections with Fanout publish/subscribe channels. Whenever Apollo needs to publish data to clients, it makes an HTTP request to Fanout Cloud with the payload, which will get injected into the appropriate WebSocket connections. It's important to note that it's the Apollo *server* that sets up the Fanout subscriptions, and the client has no awareness of this. For more about Fanout, see the [docs](https://docs.fanout.io/docs).

The application keeps track of active GraphQL subscriptions by storing information about them in DynamoDB. When a mutation operation is performed, the database is checked for subscriptions that would need to be notified as a result. For each subscription that should receive an event, its Apollo resolver is executed, and the resulting filtered payload (if any) is sent to Fanout Cloud for client delivery.

## Running locally

You can run the GraphQL Server locally by running:

```
npm start
```

This will run [./src/FanoutGraphqlServer.ts](./src/FanoutGraphqlServer.ts) configured for in-memory storage.

Example:

```
$ npm start

> aws-typescript@ start /mnt/c/Users/bengo/dev/fanout/apollo-demo
> ts-node src/FanoutGraphqlServer

🚀 Server ready at http://localhost:51930/
```

## Deploying to AWS

You can deploy the app to AWS and have it run on AWS Lambda, API Gateway, and DynamoDB for storage.

The specific AWS resources required are encoded in this source code repository using TypeScript and objects from the [@pulumi](https://pulumi.io/quickstart/) npm modules. This is a pattern called [Infrastructure as Code](https://en.wikipedia.org/wiki/Infrastructure_as_code), and is useful because it lets us apply the same software development methodologies and change controls to our cloud resources as we do to our application source code.

You'll need an AWS Account. This repository will depend on the `AWS_PROFILE` environment variable being set.
This value should correspond to an entry in your `~/.aws/credentials` file, from which AWS SDKs will pull your account's access key and secret.
For more on all this, see [AWS User Guide - Named Profiles](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-profiles.html).

The following steps illustrate how to apply the configuration in this repository to 'the cloud'. If you encounter any issues in your development environment, please file an issue at https://github.com/fanout/apollo-demo.

1. Ensure you have proper AWS credentials for our AWS accounts, add them to an aws-cli named profile, and ensure the `AWS_PROFILE` environment variable is set to the profile you want to use

  ```
  export AWS_PROFILE=yourprofile
  ```

2. Install pulumi following instructions at https://pulumi.io/quickstart/

3. Clone this repository and `cd` into the top-level directory

4. `npm install`

5. `pulumi up` and follow the CLI instructions.
