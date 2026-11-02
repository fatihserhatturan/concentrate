<script lang="ts">
  let { post } = $props();
</script>

<article><a href="/blog/{post.slug}">{post.title}</a></article>
