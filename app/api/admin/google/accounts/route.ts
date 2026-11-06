import { NextResponse } from "next/server";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import {
  CreateGbpLocationError,
  listGoogleAccountsForOrg,
} from "@/lib/google/createLocation";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";
import { GoogleOAuthError } from "@/lib/google/oauthConfig";
import { TokenEncryptionError } from "@/lib/crypto/tokenEncryption";
import { isOrgResult, requireOrganizationId } from "@/lib/org/requireOrg";

export const runtime = "nodejs";

/**
 * List GBP accounts available on the active org's platform Google connection.
 * Super Admin only — used to pick parent accounts/{accountId} for create.
 */
export async function GET() {
  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  const org = await requireOrganizationId();
  if (!isOrgResult(org)) return org.response;

  try {
    const accounts = await listGoogleAccountsForOrg(org.orgId);
    return NextResponse.json({
      success: true,
      orgId: org.orgId,
      accounts,
    });
  } catch (err) {
    if (
      err instanceof CreateGbpLocationError ||
      err instanceof GoogleBusinessApiError ||
      err instanceof GoogleOAuthError
    ) {
      return NextResponse.json(
        { success: false, code: err.code, message: err.message },
        { status: err.status }
      );
    }
    if (err instanceof TokenEncryptionError) {
      return NextResponse.json(
        {
          success: false,
          code: "token_error",
          message:
            "Stored Google credentials could not be decrypted. Reconnect Google under GMB.",
        },
        { status: 500 }
      );
    }
    console.error(
      "List Google accounts failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      {
        success: false,
        code: "list_accounts_failed",
        message: "Could not list Google Business Profile accounts.",
      },
      { status: 500 }
    );
  }
}
