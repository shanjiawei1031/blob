---
title: leetcode727
date: 2025-11-07 20:40:37
categories: 算法
tags:
  - leetcode
  - sliding-window
  - java
---

## 最小窗口子序列

### 题目描述

> 给定字符串 `s1` 和 `s2`，找出 `s1` 中最短的连续 **子串**，使得 `s2` 是该子串的 **子序列** 。

> 如果 `s1` 中没有窗口可以包含 `s2` 中的所有字符，返回空字符串 `""`。如果有不止一个最短长度的窗口，返回 **开始位置最靠左** 的那个。

### 示例 1

```
输入：
s1 = "abcdebdde", s2 = "bde"
输出："bcde"
解释：
"bcde" 是答案，因为它在相同长度的字符串 "bdde" 出现之前。
"deb" 不是一个更短的答案，因为在窗口中必须按顺序出现 T 中的元素。
```

### 示例 2

```
输入：s1 = "jmeqksfrsdcmsiwvaovztaqenprpvnbstl", s2 = "u"
输出：""
```

### 解题思路

用滑动窗口去做，遍历 `s1` 串，如果 `s2` 到了末尾（`p2 == l2`），进行回溯寻找起点。

### 代码实现

```java
class Solution {
    public String minWindow(String s1, String s2) {
        int l1 = s1.length(), l2 = s2.length();
        int p1 = 0, p2 = 0;
        int min = l1 + 1;
        String res = "";
        while (p1 < l1) {
            if (s1.charAt(p1) == s2.charAt(p2)) {
                p2++;
            }
            if (p2 == l2) {
                int r = p1;
                while (p2 > 0) {
                    if (s1.charAt(p1) == s2.charAt(p2 - 1)) {
                        p2--;
                    }
                    p1--;
                }
                p1++;
                if (r - p1 + 1 < min) {
                    min = r - p1 + 1;
                    res = s1.substring(p1, r + 1);
                }
            }
            p1++;
        }
        return res;
    }
}
```

### 注意点

1. 因为先做 `p2++`，所以末尾的判断条件是 `p2 == l2`，而不是 `p2 == l2 - 1`，此时 `p1` 还没加 1，还在最后一个字符位置。
2. 进行回溯后，`p1` 指向的位置是第一个字符的前一个位置，所以要加 1。
3. 要维护一个 `min` 变量，判断这个长度是不是最小的，如果是，就动态更新 `res` 的值。
4. 因为 `p1` 的坐标进行了回溯，最后又加 1 了，所以下一次遍历是从 `s1` 的下一个字符开始的。`s1` 确实需要进行遍历，因为要找到最小的子串。
