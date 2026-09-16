import { createApplication } from "./server.js";
const server = await createApplication();
server.http.listen(Number(process.env.PORT) || 5000, "0.0.0.0", () =>
  console.log("CertFlow API is listening."),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    const deadline = setTimeout(() => process.exit(1), 55000);
    deadline.unref();
    void server.close().then(() => process.exit(0));
  });
