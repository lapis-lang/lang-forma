# GitHub Copilot Instructions

- never use eslint-disable-next-line complexity or similar. resolve the complexity issues.
- never auto-publish a branch, nor push it to the remote repository without review. Don't stage or
  commit changes without user approval.
- Don't reference the backlog or any external issue tracking IDs in our code comments. We also don't
  need a history lesson in the comments; focus on explaining the code itself.
- don't use inline import statements. Instead, import statements should be placed at the top of the
  file