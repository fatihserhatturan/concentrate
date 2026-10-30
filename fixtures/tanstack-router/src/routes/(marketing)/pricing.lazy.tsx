import { createLazyFileRoute } from "@tanstack/react-router";

export const Route = createLazyFileRoute("/(marketing)/pricing")({
  component: Pricing,
});

function Pricing() {
  return <table />;
}
