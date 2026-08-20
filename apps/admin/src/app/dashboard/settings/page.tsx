import type { Metadata } from "next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { rootUser } from "@/data/users";

import { AppearanceSettings } from "./_components/appearance-settings";
import { ProfileForm } from "./_components/profile-form";

export const metadata: Metadata = {
  title: "Settings",
};

export default function Page() {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm">Manage your profile and how the dashboard looks.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>How your name and email appear across the app.</CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileForm defaultValues={{ name: rootUser.name, email: rootUser.email }} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Applies to this browser only.</CardDescription>
        </CardHeader>
        <CardContent>
          <AppearanceSettings />
        </CardContent>
      </Card>
    </div>
  );
}
