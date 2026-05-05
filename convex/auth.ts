import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

function normalizeUsername(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      profile(params) {
        const rawUsername = String(params.username ?? params.email ?? "").trim();
        const normalized = normalizeUsername(rawUsername);
        if (!normalized) {
          throw new Error("Username must contain letters or numbers");
        }
        return {
          email: `${normalized}@tom.quest`,
          name: rawUsername,
          role: "user",
        };
      },
      validatePasswordRequirements(password) {
        if (password.length < 8) {
          throw new Error("Password must be at least 8 characters");
        }
      },
    }),
  ],
});
