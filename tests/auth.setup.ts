

// import { test as setup, expect } from '@playwright/test';
// import path from 'path';

// const authFile = path.join(__dirname, '../playwright/.auth/discord.json');

// const USERNAME = process.env.NOTIFIERUSERNAME;
// const PASSWORD = process.env.NOTIFIERPASSWORD;
// setup('authenticate', async ({ page }) => {
//   await page.goto('https://discord.com/');
//   await expect(page.getByRole('link', { name: 'Log In' })).toBeVisible();
//   await page.getByRole('link', { name: 'Log In' }).click();
//   await expect(page.getByText('Email or Phone Number*')).toBeVisible();
//   await expect(page.getByRole('textbox', { name: 'Email or Phone Number*' })).toBeVisible();
//   await page.getByRole('textbox', { name: 'Email or Phone Number*' }).click();

//    await page.fill('input[name="email"]',USERNAME!);
//   await page.getByRole('textbox', { name: 'Email or Phone Number*' }).press('Tab');
//   await page.getByRole('textbox', { name: 'Password*' }).fill(PASSWORD!);
//   await page.getByRole('button', { name: 'Log In' }).click();
//   await expect(page.getByRole('button', { name: 'Set Status' })).toBeVisible();
//   await expect(page.getByRole('treeitem', { name: 'Direct Messages' }).locator('svg')).toBeVisible();


//   // End of authentication steps.

//   await page.context().storageState({ path: authFile });
// });
