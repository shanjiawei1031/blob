---
title: leetcode673
date: 2025-11-06 21:05:34
categories: 算法
tags:
  - leetcode
  - dp
  - java
---

## 最长递增子序列问题

### 题目描述

> 给定一个未排序的整数数组 `nums` ， *返回最长递增子序列的个数* 。
>
> **注意** 这个数列必须是 **严格** 递增的。

### 示例 1

```
输入: [1,3,5,4,7]
输出: 2
解释: 有两个最长递增子序列，分别是 [1, 3, 4, 7] 和[1, 3, 5, 7]。
```

### 示例 2

```
输入: [2,2,2,2,2]
输出: 5
解释: 最长递增子序列的长度是1，并且存在5个子序列的长度为1，因此输出5。
```

### 代码实现

```java
class Solution {
    public int findNumberOfLIS(int[] nums) {
        int len = nums.length;
        int[] dp = new int[len];
        int[] gp = new int[len];
        Arrays.fill(dp, 1);
        Arrays.fill(gp, 1);
        int max = 1;
        for (int i = 1; i < len; i++) {
            for (int j = 0; j < i; j++) {
                if (nums[j] < nums[i]) {
                    if (dp[j] + 1 > dp[i]) {
                        dp[i] = dp[j] + 1;
                        gp[i] = gp[j];
                    } else if (dp[j] + 1 == dp[i]) {
                        gp[i] += gp[j];
                    }
                }
            }
            max = Math.max(max, dp[i]);
        }
        int ans = 0;
        for (int i = 0; i < len; i++) {
            if (dp[i] == max) {
                ans += gp[i];
            }
        }
        return ans;
    }
}
```

### 总结

正常的求最长递增子序列是两层 for 循环、一个 `dp` 数组，求个数需要一个额外的 `gp` 数组，记录当下以 `i` 为结尾的最长子序列的个数，同时还要维护递增子序列最大值，最后遍历 `gp` 数组求和。
