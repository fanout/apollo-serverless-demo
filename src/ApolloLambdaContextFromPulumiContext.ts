import * as aws from "@pulumi/aws";
import * as AWSLambda from "aws-lambda";

/**
 * The types of Pulumi's Lambda Context and that of the apollo-graphql-lambda EventHandler are very slightly different.
 * This converts from the former to the latter.
 */
const ApolloLambdaContextFromPulumiContext = (
  pulumiContext: aws.lambda.Context,
): AWSLambda.Context => {
  const lambdaContext: AWSLambda.Context = {
    done() {
      throw new Error("done is just a placeholder ");
    },
    fail() {
      throw new Error("fail is just a placeholder ");
    },
    succeed() {
      throw new Error("succeed is just a placeholder ");
    },
    ...pulumiContext,
    getRemainingTimeInMillis: () =>
      parseInt(pulumiContext.getRemainingTimeInMillis(), 10),
    memoryLimitInMB: parseInt(pulumiContext.memoryLimitInMB, 10),
  };
  return lambdaContext;
};

export default ApolloLambdaContextFromPulumiContext;
