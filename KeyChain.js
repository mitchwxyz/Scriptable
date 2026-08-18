// Keychain get and set example

async function getOrPromptKey(key) {
  if (Keychain.contains(key)) {
    return Keychain.get(key);
  }

  const prompt = new Alert();
  prompt.title = "Enter New Key";
  prompt.message = `Please enter a value for: ${key}`;

  prompt.addTextField("key value");
  prompt.addCancelAction("Cancel"); // Index -1
  prompt.addAction("Save");         // Index 0

  const action = await prompt.presentAlert();
  console.log(action)

  if (action === 0) {
    const value = prompt.textFieldValue(0);

    if (value && value.trim() !== "") {
      Keychain.set(key, value);
      console.log(`Saved key '${key}' to Keychain.`);
      return value;
    }
  }

  console.log("Key prompt canceled or empty.");
  return null;
}

// Run it
const apiKey = await getOrPromptKey("SECRET_KEY");
console.log("Active Key:");
