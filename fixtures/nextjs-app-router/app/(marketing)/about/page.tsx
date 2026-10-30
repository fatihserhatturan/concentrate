import { Hero } from '../../../components/Hero';

// An inline server action: its own body starts with the directive.
async function subscribe(formData: FormData) {
  'use server';
  console.log(formData.get('email'));
}

// The route group leaves the URL: this page is /about.
export default function About() {
  return (
    <form action={subscribe}>
      <Hero title="About us" />
    </form>
  );
}
