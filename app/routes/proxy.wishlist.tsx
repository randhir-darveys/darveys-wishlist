import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

const WISHLIST_NAMESPACE = "custom";
const WISHLIST_KEY = "wishlist";
const WISHLIST_TYPE = "json";

type WishlistProduct = {
  id: string;
  handle: string;
  title: string;
  vendor: string;
  url: string;
  image: string;
  price: string;
  compareAt: string;
  priceRaw: string;
  compareAtRaw: string;
  collectionHandle: string;
  collectionTitle: string;
};

type WishlistProductMap = Record<string, WishlistProduct>;

type WishlistResponse = {
  ok: boolean;
  customerId?: string;
  items?: string[];
  products?: WishlistProductMap;
  count?: number;
  error?: string;
};

type ProxyContext = Awaited<ReturnType<typeof authenticate.public.appProxy>>;

export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<Response> => {
  try {
    const auth = await requireProxyCustomer(request);

    if (auth instanceof Response) return auth;

    const items = await getWishlistItems(auth.context, auth.customerGid);
    const products = await getWishlistProducts(auth.context, items);
    return json({
      ok: true,
      customerId: auth.customerId,
      items,
      products,
      count: items.length,
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: getErrorMessage(error, "Wishlist load failed"),
      },
      200,
    );
  }
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<Response> => {
  try {
    const auth = await requireProxyCustomer(request);
    if (auth instanceof Response) return auth;

    const method = request.method.toUpperCase();
    const payload = await readJsonBody(request);
    const currentItems = await getWishlistItems(auth.context, auth.customerGid);
    let nextItems = currentItems;

    if (method === "POST") {
      const intent =
        typeof payload.intent === "string" ? payload.intent.toLowerCase() : "add";

      if (intent === "remove") {
        const productGid = normalizeProductGid(payload.productId ?? payload.productGid);
        if (!productGid) {
          return json(
            { ok: false, error: "Valid `productId` or `productGid` is required" },
            400,
          );
        }
        nextItems = currentItems.filter((item: string) => item !== productGid);
      } else if (intent === "replace" && Array.isArray(payload.items)) {
        nextItems = dedupeProductGids(payload.items.map(normalizeProductGid));
      } else if (intent !== "add" && intent !== "replace") {
        return json(
          { ok: false, error: "Valid `intent` is required (add, remove, replace)" },
          400,
        );
      } else if (Array.isArray(payload.items)) {
        nextItems = dedupeProductGids(payload.items.map(normalizeProductGid));
      } else {
        const productGid = normalizeProductGid(payload.productId ?? payload.productGid);
        if (!productGid) {
          return json(
            { ok: false, error: "Valid `productId` or `productGid` is required" },
            400,
          );
        }
        nextItems = dedupeProductGids([...currentItems, productGid]);
      }
    } else if (method === "DELETE") {
      const productGid = normalizeProductGid(payload.productId ?? payload.productGid);
      if (!productGid) {
        return json(
          { ok: false, error: "Valid `productId` or `productGid` is required" },
          400,
        );
      }
      nextItems = currentItems.filter((item: string) => item !== productGid);
    } else {
      return json(
        { ok: false, error: `Method ${method} not allowed` },
        405,
        {
          Allow: "GET, POST, DELETE",
        },
      );
    }

    const savedItems = await setWishlistItems(auth.context, auth.customerGid, nextItems);
    const products = await getWishlistProducts(auth.context, savedItems);
    return json(
      {
        ok: true,
        customerId: auth.customerId,
        items: savedItems,
        products,
        count: savedItems.length,
      },
      200,
    );
  } catch (error) {
    return json(
      {
        ok: false,
        error: getErrorMessage(error, "Wishlist update failed"),
      },
      200,
    );
  }
};

type CustomerAuth = {
  context: ProxyContext;
  customerId: string;
  customerGid: string;
};

async function requireProxyCustomer(
  request: Request,
): Promise<CustomerAuth | Response> {
  const context = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");

  if (!context.admin || !context.session) {
    return json(
      { ok: false, error: "Offline session unavailable for this shop" },
      401,
    );
  }

  if (!customerId || !/^\d+$/.test(customerId)) {
    return json(
      { ok: false, error: "Customer login required" },
      401,
    );
  }

  return {
    context,
    customerId,
    customerGid: `gid://shopify/Customer/${customerId}`,
  };
}

async function getWishlistItems(
  context: ProxyContext,
  customerGid: string,
): Promise<string[]> {
  const response = await context.admin!.graphql(
    `#graphql
      query WishlistCustomer($customerId: ID!, $namespace: String!, $key: String!) {
        customer(id: $customerId) {
          metafield(namespace: $namespace, key: $key) {
            value
          }
        }
      }`,
    {
      variables: {
        customerId: customerGid,
        namespace: WISHLIST_NAMESPACE,
        key: WISHLIST_KEY,
      },
    },
  );

  const payload = (await response.json()) as {
    data?: {
      customer?: {
        metafield?: {
          value?: string | null;
        } | null;
      } | null;
    };
    errors?: Array<{ message?: string }>;
  };

  if (payload.errors?.length) {
    console.error("Wishlist read GraphQL errors", payload.errors);
    throw new Error(payload.errors[0]?.message ?? "Failed to read wishlist metafield");
  }

  const raw = payload.data?.customer?.metafield?.value;
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return dedupeProductGids(parsed.map(normalizeProductGid));
  } catch {
    return [];
  }
}

async function setWishlistItems(
  context: ProxyContext,
  customerGid: string,
  items: string[],
): Promise<string[]> {
  const response = await context.admin!.graphql(
    `#graphql
      mutation WishlistMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            value
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: customerGid,
            namespace: WISHLIST_NAMESPACE,
            key: WISHLIST_KEY,
            type: WISHLIST_TYPE,
            value: JSON.stringify(items),
          },
        ],
      },
    },
  );

  const payload = (await response.json()) as {
    data?: {
      metafieldsSet?: {
        metafields?: Array<{ value?: string | null }> | null;
        userErrors?: Array<{ message?: string }> | null;
      } | null;
    };
    errors?: Array<{ message?: string }>;
  };

  if (payload.errors?.length) {
    console.error("Wishlist write GraphQL errors", payload.errors);
    throw new Error(payload.errors[0]?.message ?? "Failed to save wishlist metafield");
  }

  const userErrors = payload.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length) {
    console.error("Wishlist write userErrors", userErrors);
    throw new Error(userErrors[0]?.message ?? "Failed to save wishlist metafield");
  }

  const raw = payload.data?.metafieldsSet?.metafields?.[0]?.value;
  if (!raw) return items;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return items;
    return dedupeProductGids(parsed.map(normalizeProductGid));
  } catch {
    return items;
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return {};
    }
    return body as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function getWishlistProducts(
  context: ProxyContext,
  productGids: string[],
): Promise<WishlistProductMap> {
  const ids = dedupeProductGids(productGids.map(normalizeProductGid));
  if (!ids.length) return {};

  try {
    const response = await context.admin!.graphql(
      `#graphql
        query WishlistProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            __typename
            ... on Product {
              id
              handle
              title
              vendor
              onlineStoreUrl
              featuredImage {
                url
              }
              variants(first: 1) {
                nodes {
                  price
                  compareAtPrice
                }
              }
            }
          }
        }`,
      {
        variables: {
          ids,
        },
      },
    );

    const payload = (await response.json()) as {
      data?: {
        nodes?: Array<{
          __typename?: string;
          id?: string | null;
          handle?: string | null;
          title?: string | null;
          vendor?: string | null;
          onlineStoreUrl?: string | null;
          featuredImage?: { url?: string | null } | null;
          variants?: {
            nodes?: Array<{
              price?: string | null;
              compareAtPrice?: string | null;
            }> | null;
          } | null;
        } | null> | null;
      };
      errors?: Array<{ message?: string }>;
    };

    if (payload.errors?.length) {
      console.error("Wishlist product GraphQL errors", payload.errors);
      return {};
    }

    const products: WishlistProductMap = {};
    const nodes = payload.data?.nodes ?? [];

    for (const node of nodes) {
      if (!node || node.__typename !== "Product") continue;

      const productGid = normalizeProductGid(node.id);
      if (!productGid) continue;

      const productId = productIdFromGid(productGid);
      if (!productId) continue;

      const variant = node.variants?.nodes?.[0];
      const priceRaw = toStringValue(variant?.price);
      const compareAtRaw = toStringValue(variant?.compareAtPrice);
      const handle = toStringValue(node.handle);

      products[productGid] = {
        id: productId,
        handle,
        title: toStringValue(node.title),
        vendor: toStringValue(node.vendor),
        url: toStringValue(node.onlineStoreUrl) || (handle ? `/products/${handle}` : ""),
        image: toStringValue(node.featuredImage?.url),
        price: priceRaw,
        compareAt: compareAtRaw,
        priceRaw,
        compareAtRaw,
        collectionHandle: "",
        collectionTitle: "",
      };
    }

    return products;
  } catch (error) {
    console.error("Wishlist product hydration failed", error);
    return {};
  }
}

function normalizeProductGid(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;

  const normalized = String(value).trim();
  if (!normalized) return null;

  if (/^\d+$/.test(normalized)) {
    return `gid://shopify/Product/${normalized}`;
  }

  if (/^gid:\/\/shopify\/Product\/\d+$/.test(normalized)) {
    return normalized;
  }

  return null;
}

function dedupeProductGids(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function productIdFromGid(gid: string): string | null {
  const match = gid.match(/^gid:\/\/shopify\/Product\/(\d+)$/);
  return match ? match[1] : null;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function json(
  body: WishlistResponse,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    },
  });
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}
