import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import FanoutGraphqlAppLambdaCallback from "./FanoutGraphqlAppLambdaCallback";

const FanoutGraphqlAwsApp = (name: string) => {
  const lambdaFunction = new aws.lambda.CallbackFunction(`${name}-fn-graphql`, {
    callback: FanoutGraphqlAppLambdaCallback(),
  });
  const routes: awsx.apigateway.Route[] = [
    {
      eventHandler: lambdaFunction,
      method: "GET",
      path: "/",
    },
    {
      eventHandler: lambdaFunction,
      method: "POST",
      path: "/",
    },
  ];
  return { routes };
};

export default FanoutGraphqlAwsApp;
