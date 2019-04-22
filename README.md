# fanout.io lambda/apollo demo

An example of how to use AWS Lambda with fanout.io.

The specific AWS resources required are encoded in this source code repository using TypeScript and objects from the [@pulumi](https://pulumi.io/quickstart/) npm modules. This is a pattern called [Infrastructure as Code](https://en.wikipedia.org/wiki/Infrastructure_as_code), and is useful because it lets us apply the same software development methodologies and change controls to our cloud resources as we do to our application source code.

## Usage

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

You can also deploy the app to AWS and have it run on AWS Lambda, API Gateway, and DynamoDB for storage.

You'll need an AWS Account. This repository will depend on the `AWS_PROFILE` environment variable being set.
This value should correspond to an entry in your `~/.aws/credentials` file, from which AWS SDKs will pull your account's access key and secret.
For more on all this, see [AWS User Guide - Named Profiles](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-profiles.html).

The following steps illustrate how to apply the configuration in this repository to 'the cloud'. If you encounter any issues in your development environment, please file an issue at https://github.com/fanout/apollo-demo.

1. Ensure you have proper AWS credentials for our AWS accounts, add them to an aws-cli named profile, and ensure the `AWS_PROFILE` environment variable is set to the profile you want to use

  ```
  export AWS_PROFILE=you@fanout.io
  ```

2. Install pulumi following instructions at https://pulumi.io/quickstart/

3. Clone this repository and `cd` into the top-level directory

4. `npm install`

5. `pulumi up` and follow the CLI instructions.
