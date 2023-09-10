import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import AWS, { DynamoDB } from "aws-sdk";
import { v4 } from "uuid";
import * as yup from "yup";

const docClient = new AWS.DynamoDB.DocumentClient();
const tableName = "ShoeProductsTable";
const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Headers":
    "Content-Type,X-Amz-Date,X-Amz-Security-Token,Authorization,X-Api-Key,X-Requested-With,Accept,Access-Control-Allow-Methods,Access-Control-Allow-Origin,Access-Control-Allow-Headers",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  "X-Requested-With": "*",
  "Access-Control-Max-Age": 3000,
  "Access-Control-Expose-Headers": "ETag",
  "Access-Control-Allow-Credentials": true,
};

const schema = yup.object().shape({
  name: yup.string().max(250).required(),
  description: yup.string().max(1000).required(),
  price: yup.number().min(1).max(10000).required(),
  available: yup.bool().required(),
  media: yup.array().of(yup.string().url()).required(),
  company: yup.string().max(100).required(),
  currency: yup
    .string()
    .matches(/^(€|\$)$/)
    .required(),
  colors: yup.array().of(yup.string().max(10).matches(/^#/)).required(),
  reviewsCount: yup.number().positive().integer().nullable(),
  avgReviews: yup.number().min(1).max(5).nullable(),
  featured: yup.bool().nullable(),
});

class HttpError extends Error {
  constructor(
    public statusCode: number,
    body: Record<string, unknown> = {},
  ) {
    super(JSON.stringify(body));
  }
}

const handleError = (e: unknown) => {
  if (e instanceof yup.ValidationError) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        errors: e.errors,
      }),
    };
  }

  if (e instanceof SyntaxError) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: `invalid request body format : "${e.message}"`,
      }),
    };
  }

  if (e instanceof HttpError) {
    return {
      statusCode: e.statusCode || 400,
      headers,
      body: e.message,
    };
  }

  throw e;
};

export const createShoeProduct = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const reqBody = JSON.parse(event.body as string);

    await schema.validate(reqBody, { abortEarly: false });

    const product = {
      ...reqBody,
      shoeProductID: v4(),
    };

    await docClient
      .put({
        TableName: tableName,
        Item: product,
      })
      .promise();

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        data: product,
      }),
    };
  } catch (e) {
    return handleError(e);
  }
};

const fetchShoeProductById = async (id: string) => {
  const output = await docClient
    .get({
      TableName: tableName,
      Key: {
        shoeProductID: id,
      },
    })
    .promise();

  if (!output.Item) {
    return handleError(new HttpError(404, { error: "not found" }));
  }

  return output.Item;
};

export const getShoeProduct = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const product = await fetchShoeProductById(event.pathParameters?.id as string);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        data: product,
      }),
    };
  } catch (e) {
    return handleError(e);
  }
};

export const updateShoeProduct = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id as string;

    await fetchShoeProductById(id);

    const reqBody = JSON.parse(event.body as string);

    await schema.validate(reqBody, { abortEarly: false });

    const product = {
      ...reqBody,
      shoeProductID: id,
    };

    await docClient
      .put({
        TableName: tableName,
        Item: product,
      })
      .promise();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        data: product,
      }),
    };
  } catch (e) {
    return handleError(e);
  }
};

export const deleteShoeProduct = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id as string;

    await fetchShoeProductById(id);

    await docClient
      .delete({
        TableName: tableName,
        Key: {
          shoeProductID: id,
        },
      })
      .promise();

    return {
      statusCode: 204,
      body: JSON.stringify(null),
    };
  } catch (e) {
    return handleError(e);
  }
};

export const listShoeProduct = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const filters = event.queryStringParameters;
    const { query, pageSize, nextPageKey } = filters || {};

    const defaultPageSize = 10;
    const parsedPageSize = Number(pageSize) || defaultPageSize;

    const params: DynamoDB.DocumentClient.ScanInput = {
      TableName: tableName,
    };

    if (query) {
      params.FilterExpression = "contains(#attrName1, :query) OR contains(#attrName2, :query)";
      params.ExpressionAttributeNames = {
        "#attrName1": "name",
        "#attrName2": "description",
      };
      params.ExpressionAttributeValues = {
        ":query": query,
      };
    }

    const totalCount = await docClient.scan(params).promise();

    params.Limit = parsedPageSize;
    // Convert lastEvaluatedKey as nextPageKey from a string to a DynamoDB Key object
    const exclusiveStartKey: DynamoDB.DocumentClient.Key | undefined = nextPageKey
      ? JSON.parse(Buffer.from(nextPageKey, "base64").toString())
      : undefined;
    params.ExclusiveStartKey = exclusiveStartKey;
    const results = await docClient.scan(params).promise();

    // Determine if there are more results and construct the LastEvaluatedKey
    let nextLastEvaluatedKey;
    if (results.LastEvaluatedKey) {
      nextLastEvaluatedKey = Buffer.from(JSON.stringify(results.LastEvaluatedKey)).toString("base64");
    }

    const finalCollection = results?.Items?.map((obj: any) => {
      const { avgReviews, reviewsCount, colors, available, media, ...rest } = obj;
      return { ...rest, media: media.shift() };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        data: finalCollection,
        pagination: {
          pageSize: parsedPageSize,
          totalCount: totalCount.Count || 0,
          nextPageKey: nextLastEvaluatedKey || null,
        },
      }),
    };
  } catch (error) {
    return handleError(error);
  }
};
