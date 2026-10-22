export function validateRequest(schema, source = 'body') {
  return (req, res, next) => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) return next(parsed.error);
    req.validated ??= {};
    req.validated[source] = parsed.data;
    return next();
  };
}
