export class RecipeLoader {
  constructor() {
    this.recipes = [];
  }

  async loadFromProject(projectPath) {
    if (!projectPath) return;
    try {
      const data = await window.nexus.loadRecipes(projectPath);
      if (data && Array.isArray(data.recipes)) {
        this.recipes = data.recipes.filter(r => r.name && r.prompt);
      }
    } catch {
      // No recipe file or invalid JSON — silently ignore
      this.recipes = [];
    }
  }

  getRecipes() {
    return this.recipes;
  }
}
