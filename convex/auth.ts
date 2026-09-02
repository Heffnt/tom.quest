import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { accountEmail } from "./authUsername";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      profile(params) {
        const rawUsername = String(params.username ?? params.email ?? "").trim();
        const email = accountEmail(rawUsername);
        if (!email) {
          throw new Error("Username must contain letters or numbers");
        }
        return {
          email,
          name: rawUsername,
          role: "user",
        };
      },
      validatePasswordRequirements(password) {
        if (password.length < 6) {
          throw new Error("Password must be at least 6 characters");
        }
      },
    }),
  ],
});
