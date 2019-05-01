import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as cloud from "@pulumi/cloud";
import FanoutGraphqlAppLambdaCallback from "./FanoutGraphqlAppLambdaCallback";
import { IFanoutGraphqlServerGripOptions } from "./FanoutGraphqlExpressServer";

interface IFanoutGraphqlAwsAppOptions {
  /** configure grip or disable it */
  grip: false | IFanoutGraphqlServerGripOptions;
}

const FanoutGraphqlAwsApp = (
  name: string,
  options: IFanoutGraphqlAwsAppOptions,
) => {
  console.log("FanoutGraphqlAwsApp", { options });
  const lambdaFunction = new aws.lambda.CallbackFunction(`${name}-fn-graphql`, {
    callback: FanoutGraphqlAppLambdaCallback({
      grip: options.grip,
      tables: {
        notes: new cloud.Table(`${name}-notes`),
      },
    }),
    timeout: 30,
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
