import { getMainDefinition } from "apollo-utilities";
import { ValueNode } from "graphql";
import gql from "graphql-tag";
import { ValuesOfCorrectType } from "graphql/validation/rules/ValuesOfCorrectType";

/** Given a graphql query and a argument name, return the value of that argument in the query */
export const getQueryArgumentValue = (
  query: string,
  argumentName: string,
): ValueNode => {
  const parsedQuery = gql`
    ${query}
  `;
  const mainDefinition = getMainDefinition(parsedQuery);
  const selectionSet = mainDefinition.selectionSet;
  const primarySelection = selectionSet.selections[0];
  if (primarySelection.kind !== "Field") {
    throw new Error(
      `query first selection must be of kind Field, but got ${
        primarySelection.kind
      }`,
    );
  }
  const argument = (primarySelection.arguments || []).find(
    a => argumentName === a.name.value,
  );
  if (!argument) {
    throw new Error(
      `Could not find argument named ${argumentName} after parsing query`,
    );
  }
  const argumentValueNode = argument.value;
  return argumentValueNode;
};

/**
 * Given a ValueNode and some variables from a query, interpolate the variables and return a final value.
 * The provided variables will only e used if ValueNode.kind === "Variable".
 * Otherwise this just returns the .value of the ValueNode.
 */
export const interpolateValueNodeWithVariables = (
  valueNode: ValueNode,
  variables: any,
) => {
  switch (valueNode.kind) {
    case "Variable":
      return variables[valueNode.name.value];
    case "NullValue":
      return null;
    case "ListValue":
    case "ObjectValue":
      throw new Error(`Unsupported ValueNode type ${valueNode.kind}`);
    default:
      return valueNode.value;
  }
};
